#![allow(dead_code)]
include!(concat!(env!("OUT_DIR"), "/actual_sources.rs"));
use eyre::{Result, ensure};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};
use wasm_stream::{passes::post_combine::PostCombineStreamPass, pipeline::StreamPass};
use wasmparser::{ExternalKind, Operator, Parser, Payload, TypeRef, ValType};

const FIXTURE: &str = r#"(module
  (import "env" "memory" (memory 1 1 shared))
  (import "wvl_atomic" "__wvl_atomic_wait32_vfs" (func $wait (param i32 i32 i64) (result i32)))
  (import "wvl_atomic" "__wvl_atomic_notify_vfs" (func $notify (param i32 i32) (result i32)))
  (export "wait32" (func $wait))
  (export "notify" (func $notify))
  (export "memory" (memory 0))
  (func (export "wait_via_call") (param i32 i32 i64) (result i32)
    local.get 0 local.get 1 local.get 2 call $wait)
  (func (export "notify_via_call") (param i32 i32) (result i32)
    local.get 0 local.get 1 call $notify))"#;

fn validate(bytes: &[u8]) -> Result<()> {
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all()).validate_all(bytes)?;
    Ok(())
}

fn inspect(bytes: &[u8]) -> Result<serde_json::Value> {
    validate(bytes)?;
    let mut types = Vec::new();
    let mut functions = Vec::new();
    let mut exports = HashMap::new();
    let mut bodies = Vec::new();
    let mut memories = Vec::new();
    let mut imports = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::TypeSection(s) => for ty in s.into_iter_err_on_gc_types() { types.push(ty?); },
            Payload::ImportSection(s) => for group in s { for import in group? {
                let (_, i) = import?;
                imports.push(format!("{}::{}", i.module, i.name));
                match i.ty {
                    TypeRef::Memory(m) => memories.push(m),
                    _ => eyre::bail!("unexpected remaining import {}::{}", i.module, i.name),
                }
            }},
            Payload::MemorySection(s) => for m in s { memories.push(m?); },
            Payload::FunctionSection(s) => for f in s { functions.push(f?); },
            Payload::ExportSection(s) => for e in s { let e = e?; if e.kind == ExternalKind::Func { exports.insert(e.name.to_string(), e.index); } },
            Payload::CodeSectionEntry(body) => {
                ensure!(body.get_locals_reader()?.get_count() == 0, "unexpected generated locals");
                bodies.push(body.get_operators_reader()?.into_iter().collect::<std::result::Result<Vec<_>, _>>()?);
            }
            _ => {}
        }
    }
    ensure!(imports == ["env::memory"], "ABI imports were not eliminated");
    ensure!(memories.len() == 1 && memories[0].shared && !memories[0].memory64
        && memories[0].initial == 1 && memories[0].maximum == Some(1), "wrong shared memory");
    let mut report = Vec::new();
    for (name, params) in [
        ("wait32", vec![ValType::I32, ValType::I32, ValType::I64]),
        ("notify", vec![ValType::I32, ValType::I32]),
        ("wait_via_call", vec![ValType::I32, ValType::I32, ValType::I64]),
        ("notify_via_call", vec![ValType::I32, ValType::I32]),
    ] {
        let index = *exports.get(name).ok_or_else(|| eyre::eyre!("missing export {name}"))? as usize;
        let ty = &types[functions[index] as usize];
        ensure!(ty.params() == params && ty.results() == [ValType::I32], "wrong signature for {name}");
        let ops = &bodies[index];
        ensure!(ops.len() == params.len() + 2, "extra/missing instructions: {name}");
        for (i, op) in ops.iter().take(params.len()).enumerate() {
            ensure!(matches!(op, Operator::LocalGet {local_index} if *local_index == i as u32), "argument forwarding {name}:{i}");
        }
        ensure!(matches!(ops.last(), Some(Operator::End)), "missing end");
        let op = &ops[params.len()];
        if name.ends_with("via_call") {
            let target = if name.starts_with("wait") { "wait32" } else { "notify" };
            ensure!(matches!(op, Operator::Call {function_index} if *function_index == exports[target]), "call not rebound to generated {target}");
        } else {
            let memarg = match (name, op) {
                ("wait32", Operator::MemoryAtomicWait32 {memarg}) => memarg,
                ("notify", Operator::MemoryAtomicNotify {memarg}) => memarg,
                _ => eyre::bail!("wrong actual generated opcode: {name}: {op:?}"),
            };
            ensure!(memarg.memory == 0 && memarg.offset == 0 && memarg.align == 2, "wrong atomic memarg: {memarg:?}");
        }
        report.push(json!({"export":name,"function_index":index,"params":format!("{:?}",ty.params()),
            "results":format!("{:?}",ty.results()),"operators":ops.iter().map(|o|format!("{o:?}")).collect::<Vec<_>>() }));
    }
    Ok(json!({"imports":imports,"shared_memory":{"index":0,"initial":1,"maximum":1},"functions":report}))
}

fn main() -> Result<()> {
    let out = PathBuf::from(std::env::args_os().nth(1).ok_or_else(||eyre::eyre!("usage: harness OUTPUT_DIR"))?);
    let input = wat::parse_str(FIXTURE)?;
    validate(&input)?;
    std::fs::write(out.join("input.wat"), FIXTURE)?;
    std::fs::write(out.join("input.wasm"), &input)?;
    let mut cases = Vec::new();
    for threads in [true, false] {
        let mut pass = PostCombineStreamPass::new("vfs".into(), vec![], vec![2], threads);
        let output = pass.run(&input)?;
        let structure = inspect(&output)?;
        let filename = if threads { "lowered.wasm" } else { "lowered-no-threads.wasm" };
        std::fs::write(out.join(filename), output)?;
        cases.push(json!({"threads":threads,"file":filename,"structure":structure}));
    }
    // Wrong ABI must not accidentally pass validation or the structural oracle.
    let invalid = wat::parse_str(FIXTURE.replace("i32 i32 i64", "i32 i32 i32"))?;
    let malformed = PostCombineStreamPass::new("vfs".into(), vec![], vec![2], true).run(&invalid)?;
    ensure!(inspect(&malformed).is_err(), "negative signature control accepted");
    let report = json!({"status":"pass","mode":"actual-production-source-imports","cases":cases,
        "negative_controls":{"wrong_timeout_type_rejected":true}});
    std::fs::write(out.join("structural.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
