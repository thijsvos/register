use std::path::Path;

fn main() {
    // rust-embed's codegen is `include_bytes!` over the file list it saw at
    // expansion time, so cargo reruns on content changes to known files but not
    // on new filenames. Vite emits content-hashed bundles, which means every
    // frontend rebuild produces new filenames and would otherwise leave the
    // server embedding a stale asset list. Watching the directory catches the
    // additions and removals. Needs no dependency.
    println!("cargo:rerun-if-changed=app/dist");

    // The UI is embedded from `app/dist`, and rust-embed is configured with
    // `allow_missing = true` so that a missing directory is not a compile error.
    // That is deliberate — `cargo check` and `cargo clippy` must work on a fresh
    // clone before anyone has run `pnpm build` — but it means the build order
    // can be got wrong silently: you get a binary that starts, serves 404 for
    // `/`, and looks like a broken app rather than a missed step.
    //
    // A warning rather than a hard error, for the same reason the flag is set.
    // Cargo prints it after the build, which is where someone about to run the
    // thing is looking.
    let built = Path::new("app/dist/index.html").is_file();
    if !built {
        println!(
            "cargo:warning=app/dist/index.html is missing, so this binary embeds no UI and will \
             answer 404 at /. Run `cd app && pnpm install && pnpm build` first, then build again."
        );
    }
}
