#![allow(dead_code)]
include!(concat!(env!("OUT_DIR"), "/actual_sources.rs"));
use eyre::{Result, ensure};
use wasm_stream::{passes::multi_memory_lowering::MultiMemoryLoweringStreamPass, pipeline::StreamPass};
use wasmparser::{Operator, Parser, Payload, TypeRef};

const ACQ: &str = "__wasip1_vfs_memory_lock_read_acquire";
const REL: &str = "__wasip1_vfs_memory_lock_read_release";

fn fixture(body: &str) -> Result<Vec<u8>> {
    let mut s = String::from("(module");
    for target in ["guest", "other"] {
        s += &format!("(import \"env\" \"__wasip1_vfs_own_memory_size_{target}\" (func (result i32)))
            (import \"env\" \"__wasip1_vfs_own_memory_grow_{target}\" (func (param i32) (result i32)))");
    }
    s += "(memory 1 8 shared)(memory 1 8 shared)(memory 1 8 shared)
        (global $g (mut i32) (i32.const 0))(func $hook (export \"hook\"))";
    for target in ["host", "guest", "other"] {
        s += &format!("(func (export \"__wasip1_vfs_{target}_own_memory_size_get\") (result i32) i32.const 1)
            (func (export \"__wasip1_vfs_{target}_own_memory_size_set\") (param i32))
            (func (export \"__wasip1_vfs_{target}_own_memory_size_init\") (param i32))
            (func (export \"__wasip1_vfs_{target}_own_memory_size_compare_exchange\") (param i32 i32) (result i32) local.get 0)");
    }
    for name in [ACQ, REL, "__wasip1_vfs_memory_lock_write_acquire", "__wasip1_vfs_memory_lock_write_release"] {
        s += &format!("(func (export \"{name}\"))");
    }
    s += &format!("(func (export \"run\") {body}))");
    let bytes = wat::parse_str(s)?;
    validate(&bytes)?;
    Ok(bytes)
}
fn validate(bytes: &[u8]) -> Result<()> {
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all()).validate_all(bytes)?;
    Ok(())
}
fn export(bytes: &[u8], name: &str) -> Result<u32> {
    for p in Parser::new(0).parse_all(bytes) {
        if let Payload::ExportSection(s) = p? {
            for e in s { let e = e?; if e.name == name { return Ok(e.index); } }
        }
    }
    eyre::bail!("missing export {name}")
}
fn ops(bytes: &[u8]) -> Result<Vec<Operator<'_>>> {
    let target = export(bytes, "run")?;
    let mut idx = 0;
    for p in Parser::new(0).parse_all(bytes) {
        match p? {
            Payload::ImportSection(s) => for group in s { for i in group? {
                if matches!(i?.1.ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) { idx += 1; }
            }},
            Payload::CodeSectionEntry(body) => {
                if idx == target { return Ok(body.get_operators_reader()?.into_iter().collect::<std::result::Result<_, _>>()?); }
                idx += 1;
            }
            _ => {}
        }
    }
    eyre::bail!("run not found")
}
// Independent small opcode vocabulary; never invokes production classifiers.
fn scalar(op: &Operator<'_>) -> Option<(&'static str, wasmparser::MemArg)> {
    macro_rules! identify { ($($name:ident),*) => { match op {
        $(Operator::$name { memarg } => Some((stringify!($name), *memarg)),)*
        _ => None,
    } }; }
    identify!(I32Load,I64Load,F32Load,F64Load,I32Load8S,I32Load8U,I32Load16S,I32Load16U,
        I64Load8S,I64Load8U,I64Load16S,I64Load16U,I64Load32S,I64Load32U,I32Store,I64Store,
        F32Store,F64Store,I32Store8,I32Store16,I64Store8,I64Store16,I64Store32)
}
fn bridge(op: &Operator<'_>) -> bool {
    matches!(op, Operator::Nop | Operator::Drop | Operator::I32Const{..} | Operator::I64Const{..}
        | Operator::F32Const{..} | Operator::F64Const{..})
}
fn mem_event(name: &str, arg: wasmparser::MemArg) -> String {
    format!("access:{name}:offset={}:align={}", arg.offset, arg.align)
}
fn visible(op: &Operator<'_>, hook: u32) -> String {
    match op {
        Operator::Call {function_index} if *function_index == hook => "original:hook".into(),
        _ => format!("original:{op:?}"),
    }
}
fn expected(bytes: &[u8], batching: bool) -> Result<Vec<String>> {
    let hook = export(bytes, "hook")?;
    let mut result = Vec::new();
    let mut held = false;
    let mut count = 0;
    for op in ops(bytes)? {
        let access = scalar(&op).filter(|(_, a)| a.memory > 0);
        if held && (count == 64 || (access.is_none() && !bridge(&op))) {
            result.push("release".into()); held = false; count = 0;
        }
        if let Some((name,arg)) = access {
            if !held { result.push("acquire".into()); held = true; count = 0; }
            result.push(format!("base:{}", arg.memory));
            result.push(mem_event(name,arg));
            if !batching { result.push("release".into()); held = false; }
        } else {
            result.push(visible(&op, hook));
        }
        if held { count += 1; }
    }
    ensure!(!held, "expected normal exit leaked");
    Ok(result)
}
fn observed(bytes: &[u8]) -> Result<Vec<String>> {
    let (acq, rel, hook) = (export(bytes,ACQ)?, export(bytes,REL)?, export(bytes,"hook")?);
    let mut result = Vec::new();
    let mut held = false;
    let mut pending_base = false;
    for op in ops(bytes)? {
        match op {
            Operator::Call {function_index} if function_index == acq => {
                ensure!(!held, "double acquisition"); held = true; result.push("acquire".into());
            }
            Operator::Call {function_index} if function_index == rel => {
                ensure!(held && !pending_base, "unmatched or premature release");
                held = false; result.push("release".into());
            }
            Operator::GlobalGet {global_index} if global_index > 0 => {
                ensure!(held && !pending_base, "base load missing ownership or access");
                pending_base = true; result.push(format!("base:{global_index}"));
            }
            Operator::LocalGet{..} | Operator::LocalSet{..} | Operator::I32Add => {
                // Generated stack/address plumbing, not semantic equivalence proof.
            }
            _ => {
                if let Some((name,arg)) = scalar(&op) {
                    ensure!(arg.memory == 0, "access not lowered to memory zero");
                    if arg.offset == 4096 {
                        ensure!(!held, "inherited lock on host access");
                        result.push(visible(&op,hook));
                    } else {
                        ensure!(held && pending_base, "guest access lacks fresh protected base");
                        pending_base = false; result.push(mem_event(name,arg));
                    }
                } else {
                    if !bridge(&op) { ensure!(!held, "inherited lock across barrier {op:?}"); }
                    result.push(visible(&op,hook));
                }
            }
        }
    }
    ensure!(!held && !pending_base, "exit leaked");
    Ok(result)
}
fn main() -> Result<()> {
    let mut cases = Vec::<(String,String)>::new();
    let load = "i32.const 0 i32.load 1 drop";
    for gap in [0, 59, 60, 61, 62, 63, 64, 65, 126, 127, 128] {
        cases.push((format!("bridge-gap-{gap}"),format!("{load} {} {load}", "nop ".repeat(gap))));
    }
    for n in [1, 2, 21, 22, 23, 63, 64, 65, 129] {
        cases.push((format!("scalar-run-{n}"),format!("{load} ").repeat(n)));
    }
    for (i,boundary) in ["call $hook", "global.get $g drop", "i32.const 7 global.set $g", "block end",
        "loop end", "i32.const 0 if else end", "block i32.const 0 br_if 0 end",
        "i32.const 1 i32.const 1 i32.div_s drop", "f64.const 0 i32.trunc_f64_s drop",
        "i32.const 0 i32.load 0 offset=4096 drop", "return", "unreachable"].iter().enumerate() {
        cases.push((format!("barrier-{i}"),format!("{load} {boundary} {load}")));
    }
    let scalar_specs = [
        ("i32.load",""),("i64.load",""),("f32.load",""),("f64.load",""),
        ("i32.load8_s",""),("i32.load8_u",""),("i32.load16_s",""),("i32.load16_u",""),
        ("i64.load8_s",""),("i64.load8_u",""),("i64.load16_s",""),("i64.load16_u",""),
        ("i64.load32_s",""),("i64.load32_u",""),("i32.store","i32.const 7"),
        ("i64.store","i64.const 9"),("f32.store","f32.const 1.5"),("f64.store","f64.const 2.5"),
        ("i32.store8","i32.const 7"),("i32.store16","i32.const 7"),
        ("i64.store8","i64.const 9"),("i64.store16","i64.const 9"),("i64.store32","i64.const 9")];
    let mut mixed = String::new();
    for (i,(mnemonic,value)) in scalar_specs.iter().enumerate() {
        let guest = 1 + i % 2;
        mixed += &format!("i32.const 0 {value} {mnemonic} {guest} offset=8 {} ", if value.is_empty(){"drop"}else{""});
    }
    cases.push(("all23-scalars-mixed-guests".into(),mixed));
    let mut report = Vec::new();
    let mut negative_controls = None;
    for (name,body) in cases {
        let input = fixture(&body)?;
        for enabled in [false,true] {
            let prediction = expected(&input,enabled)?;
            let output = MultiMemoryLoweringStreamPass::new(true,true,vec!["guest".into(),"other".into()],true)
                .with_memory_lock_batching(enabled).run(&input)?;
            validate(&output)?;
            let actual = observed(&output)?;
            ensure!(prediction == actual, "schedule mismatch {name} batching={enabled}\nexpected={prediction:?}\nactual={actual:?}");
            if name == "all23-scalars-mixed-guests" && enabled {
                let mut missing_base = actual.clone();
                missing_base.remove(missing_base.iter().position(|e| e.starts_with("base:")).unwrap());
                let mut missing_release = actual.clone();
                missing_release.remove(missing_release.iter().position(|e| e == "release").unwrap());
                let mut wrong_guest = actual.clone();
                *wrong_guest.iter_mut().find(|e| e.starts_with("base:")).unwrap() = "base:999".into();
                ensure!(prediction != missing_base && prediction != missing_release && prediction != wrong_guest,
                    "event comparison failed negative controls");
                negative_controls = Some(serde_json::json!({"omitBase":true,"omitRelease":true,"wrongGuestBase":true}));
            }
            report.push(serde_json::json!({"case":name,"batching":enabled,"eventCount":actual.len(),
                "acquisitions":actual.iter().filter(|e| e.as_str()=="acquire").count()}));
        }
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"stage":"3a","passed":true,
        "claim":"selected actual-pass emitted-event correspondence, not full pipeline proof",
        "scalarKinds":23,"validatedOutputs":report.len(),"cases":report,"eventMutationControls":negative_controls}))?);
    Ok(())
}
