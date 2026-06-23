use std::{collections::BTreeSet, env, fs};
use wasmparser::{ExternalKind, Operator, Parser, Payload, TypeRef};

fn main() -> anyhow::Result<()> {
    let path = env::args().nth(1).expect("wasm path");
    let requested: BTreeSet<u32> = env::args()
        .skip(2)
        .map(|value| value.parse().expect("function index"))
        .collect();
    let bytes = fs::read(path)?;
    let quiet = !requested.is_empty();
    let calls_only = env::var_os("WASM_INSPECT_CALLS_ONLY").is_some();
    let mut imported_functions = 0u32;
    let mut defined_ordinal = 0u32;
    let mut next_imported_function = 0u32;

    for payload in Parser::new(0).parse_all(&bytes) {
        match payload? {
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import?;
                    if matches!(import.ty, TypeRef::Func(_)) {
                        if !quiet {
                            eprintln!(
                                "import func {} = {}::{}",
                                next_imported_function, import.module, import.name
                            );
                        }
                        next_imported_function += 1;
                        imported_functions += 1;
                    }
                }
                if !quiet {
                    eprintln!("imported functions: {imported_functions}");
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if !quiet && export.kind == ExternalKind::Func {
                        eprintln!("export {} = func {}", export.name, export.index);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                let index = imported_functions + defined_ordinal;
                defined_ordinal += 1;
                let dump_requested = requested.contains(&index);
                if dump_requested {
                    println!("=== func {index} range {:?} ===", body.range());
                }
                let mut reader = body.get_operators_reader()?;
                let mut tls_global = None;
                let mut tls_offset = None;
                let mut saw_lsp_tls = false;
                let mut saw_lsp_current_offset = false;
                while !reader.eof() {
                    let offset = reader.original_position();
                    let operator = reader.read()?;
                    let operator_text = format!("{operator:?}");
                    if requested.is_empty()
                        && (operator_text.contains("Atomic") || operator_text.contains("Wait"))
                    {
                        eprintln!("atomic/wait func={index} offset={offset:#x}: {operator_text}");
                    }
                    match operator {
                        Operator::GlobalGet { global_index: 11 } => {
                            saw_lsp_tls = true;
                            tls_global = None;
                            tls_offset = None;
                        }
                        Operator::I32Const { value: 476 } => {
                            saw_lsp_current_offset = true;
                            tls_global = None;
                            tls_offset = None;
                        }
                        Operator::GlobalGet {
                            global_index: global_index @ 1,
                        } => {
                            tls_global = Some(global_index);
                            tls_offset = None;
                        }
                        Operator::I32Const { value } if tls_global.is_some() => {
                            tls_offset = Some(value);
                        }
                        Operator::I32Add if tls_offset.is_some() => {}
                        Operator::I32Load { .. } if tls_offset.is_some() => {
                            if !quiet {
                                eprintln!(
                                    "tls load func={index} global={} offset={}",
                                    tls_global.unwrap(),
                                    tls_offset.unwrap()
                                );
                            }
                            tls_global = None;
                            tls_offset = None;
                        }
                        _ => {
                            tls_global = None;
                            tls_offset = None;
                        }
                    }
                    if dump_requested {
                        match operator {
                            Operator::Call { .. }
                            | Operator::CallIndirect { .. }
                            | Operator::MemoryAtomicWait32 { .. }
                            | Operator::MemoryAtomicWait64 { .. }
                            | Operator::MemoryAtomicNotify { .. }
                                if calls_only =>
                            {
                                println!("{offset:#x}: {operator:?}");
                            }
                            _ if !calls_only => println!("{offset:#x}: {operator:?}"),
                            _ => {}
                        }
                    }
                }
                if !quiet && saw_lsp_tls && saw_lsp_current_offset {
                    eprintln!("possible lsp current func={index}");
                }
            }
            _ => {}
        }
    }

    Ok(())
}
