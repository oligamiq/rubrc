import sys

def extract_files(diff_path, target_files):
    with open(diff_path, "r") as f:
        lines = f.readlines()
    
    current_file = None
    output = []
    capture = False
    
    for i, line in enumerate(lines):
        if line.startswith("diff --git "):
            parts = line.strip().split(" b/")
            if len(parts) == 2:
                current_file = parts[1]
                if current_file in target_files:
                    capture = True
                else:
                    capture = False
        
        if capture:
            output.append(f"{i+1}: {line}")
            
    with open("diff_extract.txt", "w") as f:
        f.writelines(output)

target_files = {
    "scripts/lsp_browser_static_server.mjs",
    "lib/src/fetch_with_optional_cache.ts",
    "scripts/sysroot_cache.ts",
    "page/src/rust_src_cache.ts",
    "scripts/prepare_rust_src_dev_asset.ts",
    "crates/vfs-shell/src/sysroot_extraction.rs",
    ".github/workflows/static.yml",
    "scripts/publish-pages-dist.sh",
    "lib/src/fetch_compressed_stream.ts",
    "page/vite.config.ts"
}
extract_files("/home/oligami/projects/rubrc/.git/worktrees/rust-analyzer-browser-clean/sdd/review-6719c15e..d47afa2e.diff", target_files)
