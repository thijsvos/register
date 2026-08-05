fn main() {
    // rust-embed's codegen is `include_bytes!` over the file list it saw at
    // expansion time, so cargo reruns on content changes to known files but not
    // on new filenames. Vite emits content-hashed bundles, which means every
    // frontend rebuild produces new filenames and would otherwise leave the
    // server embedding a stale asset list. Watching the directory catches the
    // additions and removals. Needs no dependency.
    println!("cargo:rerun-if-changed=app/dist");
}
