use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, UNIX_EPOCH};

use super::*;
use crate::vault::tests::TempVault;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vault-v1");
const PNG: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/obsidian-v1/attachments/diagram.png"
);

const NOTE: &str = "---\nid: 01J2ZK7Q8W3E5R9T\nref: 003\ntitle: Terminal aesthetics\ncreated: 2026-07-28\nmodified: 2026-08-04T13:47:00Z\ntags: [design, research]\n---\nBody text.\n";

/// A reader made of a few lines, so every assertion about the vault half runs
/// without `pnpm build` — which CI's server job never does.
pub(crate) fn stand_in() -> Reader {
    Reader {
        boot: "/* boot */".to_owned(),
        css: concat!(
            "@font-face{font-family:\"Commit Mono\";font-weight:400;",
            "src:url(/fonts/commit-mono/a.woff2) format(\"woff2\")}",
            "@font-face{font-family:\"Nowhere\";src:url(/fonts/nowhere/b.woff2)}",
            "body{margin:0}"
        )
        .to_owned(),
        js: "console.log('reader')".to_owned(),
        fonts: BTreeMap::from([("fonts/commit-mono/a.woff2".to_owned(), b"WOFF".to_vec())]),
    }
}

fn at(seconds: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(seconds)
}

/// A vault holding one note, scaffolded the way `init` would.
fn seeded() -> TempVault {
    let tmp = TempVault::new();
    scaffold::init(tmp.path(), false).expect("scaffold");
    tmp.put("notes/003-terminal-aesthetics.md", NOTE);
    tmp
}

/// The JSON the page reads, parsed back.
fn payload_of(html: &str) -> serde_json::Value {
    let open = format!("id=\"{PAYLOAD_ID}\">");
    let start = html.find(&open).expect("payload block") + open.len();
    let end = html[start..].find("</script>").expect("payload end") + start;
    serde_json::from_str(&html[start..end]).expect("payload parses")
}

fn render_stand_in(vault: &Vault, media: Media, faces: Faces) -> Rendered {
    render(vault, &stand_in(), media, faces, at(1_788_600_000)).expect("render")
}

// ---------------------------------------------------------------- what travels

#[test]
fn every_note_survives_the_round_trip() {
    let vault = Vault::open(FIXTURE).expect("open fixture");
    let rendered = render_stand_in(&vault, Media::None, Faces::All);
    let payload = payload_of(&rendered.html);

    let tree = payload["tree"]["notes"].as_array().expect("tree notes");
    assert!(
        tree.len() >= 17,
        "the fixture holds seventeen notes: {}",
        tree.len()
    );
    assert_eq!(rendered.notes, tree.len());
    for entry in tree {
        let path = entry["path"].as_str().expect("path");
        let on_disk = fs::read_to_string(format!("{FIXTURE}/{path}")).expect("read");
        assert_eq!(
            payload["notes"][path].as_str(),
            Some(on_disk.as_str()),
            "{path} came back different"
        );
    }
    assert!(rendered.skipped.is_empty(), "{:?}", rendered.skipped);
}

#[test]
fn nothing_under_the_app_directory_is_carried() {
    // The fixture's trash holds `002-retired.md` and its config names a key
    // nothing else does. Neither may reach a file made to be handed on.
    let vault = Vault::open(FIXTURE).expect("open fixture");
    let rendered = render_stand_in(&vault, Media::Inline, Faces::All);
    let payload = payload_of(&rendered.html);

    assert!(
        !rendered.html.contains("002-retired"),
        "the trash travelled"
    );
    for key in payload["notes"].as_object().expect("notes").keys() {
        assert!(!key.starts_with(".register"), "{key}");
    }
    for key in payload["files"].as_object().expect("files").keys() {
        assert!(!key.starts_with(".register"), "{key}");
    }
    assert!(payload["tree"]["git"].is_null());
}

#[test]
fn the_vault_path_is_not_carried() {
    let vault = Vault::open(FIXTURE).expect("open fixture");
    let rendered = render_stand_in(&vault, Media::None, Faces::All);
    let root = vault.root().display().to_string();

    assert!(
        !rendered.html.contains(&root),
        "the absolute path travelled"
    );
    assert_eq!(payload_of(&rendered.html)["tree"]["vault"], "vault-v1");
    assert!(rendered.html.contains("<title>REGISTER · vault-v1</title>"));
}

#[test]
fn the_licensed_face_is_never_read() {
    // Rule 7 the other way round: the bytes come from the user's own disk and
    // must not leave it in a file meant for somebody else.
    let tmp = seeded();
    let marker = b"LICENSED-FACE-BYTES-THAT-MUST-STAY-HOME";
    tmp.put(
        ".register/fonts/licensed.woff2",
        std::str::from_utf8(marker).expect("ascii"),
    );
    let rendered = render_stand_in(&tmp.open(), Media::Inline, Faces::All);

    assert!(
        !rendered
            .html
            .contains(std::str::from_utf8(marker).expect("ascii"))
    );
    assert!(!rendered.html.contains(&base64(marker)));
    assert!(!rendered.html.contains("licensed"));
}

#[test]
fn media_inline_carries_a_png_as_a_data_url() {
    let tmp = seeded();
    let png = fs::read(PNG).expect("fixture png");
    fs::write(tmp.path().join("notes/diagram.png"), &png).expect("seed png");
    let rendered = render_stand_in(&tmp.open(), Media::Inline, Faces::All);
    let payload = payload_of(&rendered.html);

    let url = payload["files"]["notes/diagram.png"]
        .as_str()
        .expect("carried");
    assert!(url.starts_with("data:image/png;base64,"), "{url}");
    assert_eq!(&url[22..], base64(&png));
    assert_eq!(rendered.files, 1);
}

#[test]
fn media_none_carries_no_file() {
    let tmp = seeded();
    fs::write(
        tmp.path().join("notes/diagram.png"),
        fs::read(PNG).expect("png"),
    )
    .expect("seed");
    let rendered = render_stand_in(&tmp.open(), Media::None, Faces::All);

    assert_eq!(
        payload_of(&rendered.html)["files"]
            .as_object()
            .map(|o| o.len()),
        Some(0)
    );
    assert_eq!(rendered.files, 0);
    assert!(rendered.skipped.is_empty());
}

#[test]
fn a_file_the_vault_would_refuse_is_left_out_and_said() {
    // A `.png` holding text is refused by `read_media`'s magic-number check on
    // a served page. The export refuses it too, and says which one.
    let tmp = seeded();
    tmp.put("notes/not-really.png", "just text");
    let rendered = render_stand_in(&tmp.open(), Media::Inline, Faces::All);

    assert_eq!(rendered.files, 0);
    assert_eq!(rendered.skipped.len(), 1);
    assert!(
        rendered.skipped[0].starts_with("notes/not-really.png:"),
        "{:?}",
        rendered.skipped
    );
}

// ---------------------------------------------------------------- the escapes

#[test]
fn a_note_holding_a_script_end_tag_cannot_break_out() {
    let tmp = seeded();
    let body = "---\ntitle: Hostile\n---\n</script><script>document.title='owned'</script>\n";
    tmp.put("notes/004-hostile.md", body);
    let rendered = render_stand_in(&tmp.open(), Media::None, Faces::All);

    // Three scripts in the template — boot, payload, module — and not one more.
    assert_eq!(rendered.html.matches("</script").count(), 3);
    assert_eq!(
        payload_of(&rendered.html)["notes"]["notes/004-hostile.md"].as_str(),
        Some(body),
        "and the note still reads exactly as written"
    );
}

#[test]
fn the_payload_carries_no_bare_angle_bracket_or_ampersand() {
    let tmp = seeded();
    tmp.put(
        "notes/005-marks.md",
        "---\ntitle: A & B <c>\n---\n<b>x</b> & y\u{2028}z\n",
    );
    let rendered = render_stand_in(&tmp.open(), Media::None, Faces::All);
    let open = format!("id=\"{PAYLOAD_ID}\">");
    let start = rendered.html.find(&open).expect("payload") + open.len();
    let end = rendered.html[start..].find("</script>").expect("end") + start;
    let block = &rendered.html[start..end];

    for forbidden in ['<', '>', '&', '\u{2028}', '\u{2029}'] {
        assert!(
            !block.contains(forbidden),
            "{forbidden:?} reached the block"
        );
    }
}

#[test]
fn the_title_is_escaped() {
    assert_eq!(escape_html("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&#39;");
}

#[test]
fn fill_never_rescans_what_it_inserted() {
    // A value that looks like a slot is copied, not filled: this is the property
    // that keeps a note reading `{{JS}}` from having the bundle written into it.
    assert_eq!(fill("a{{X}}b", &[("X", "{{Y}}"), ("Y", "no")]), "a{{Y}}b");
    assert_eq!(fill("{{A}}{{B}}", &[("A", "1"), ("B", "2")]), "12");
    // An unknown slot is left as it was rather than dropped.
    assert_eq!(fill("x{{Z}}y", &[]), "x{{Z}}y");
}

// ---------------------------------------------------------------- the sheet

#[test]
fn faces_all_inlines_the_woff2_as_data() {
    let tmp = seeded();
    let rendered = render_stand_in(&tmp.open(), Media::None, Faces::All);

    // "WOFF" is V09GRg== — the face the stand-in carries.
    assert!(
        rendered
            .html
            .contains("url(data:font/woff2;base64,V09GRg==)")
    );
    // The face it does not carry is left pointing where it pointed: it fails
    // to load and the stack moves on, as it would on a served page.
    assert!(rendered.html.contains("url(/fonts/nowhere/b.woff2)"));
    assert!(!rendered.html.contains("/fonts/commit-mono/"));
}

#[test]
fn faces_none_strips_every_font_face() {
    let tmp = seeded();
    let rendered = render_stand_in(&tmp.open(), Media::None, Faces::None);

    assert!(!rendered.html.contains("@font-face"));
    assert!(!rendered.html.contains("/fonts/"));
    assert!(
        rendered.html.contains("body{margin:0}"),
        "the rest of the sheet survives"
    );
}

// ------------------------------------------------------------------- writing

#[test]
fn an_output_inside_the_vault_is_refused() {
    let tmp = seeded();
    let inside = tmp.path().join("notes/reading.html");
    let error = export(tmp.path(), Some(&inside), Media::None, Faces::None, at(0))
        .err()
        .expect("refused");

    assert!(error.contains("inside the vault"), "{error}");
    assert!(!inside.exists());
}

#[test]
fn a_file_that_is_not_an_export_is_not_overwritten() {
    let tmp = seeded();
    let beside = TempVault::new();
    let out = beside.path().join("theirs.html");
    fs::write(&out, "somebody's page").expect("seed");

    let error = export(tmp.path(), Some(&out), Media::None, Faces::None, at(0))
        .err()
        .expect("refused");
    assert!(error.contains("not an export"), "{error}");
    assert_eq!(fs::read_to_string(&out).expect("read"), "somebody's page");
}

#[test]
fn a_folder_holding_no_vault_is_refused() {
    let tmp = TempVault::new();
    let error = export(tmp.path(), None, Media::None, Faces::None, at(0))
        .err()
        .expect("refused");
    assert!(error.contains("holds no vault"), "{error}");
}

#[test]
fn the_default_name_is_the_vault_and_the_date() {
    assert_eq!(
        default_name("vault", at(1_788_600_000)),
        "vault-2026-09-05.html"
    );
}

#[test]
fn two_exports_of_one_vault_differ_only_by_the_stamp() {
    let tmp = seeded();
    let vault = tmp.open();
    let one = render(&vault, &stand_in(), Media::None, Faces::All, at(1_000)).expect("one");
    let two = render(&vault, &stand_in(), Media::None, Faces::All, at(2_000)).expect("two");

    assert_ne!(one.html, two.html);
    assert_eq!(
        one.html.replace("1970-01-01T00:16:40Z", "STAMP"),
        two.html.replace("1970-01-01T00:33:20Z", "STAMP"),
    );
}

// ------------------------------------------------------------------ the bytes

#[test]
fn base64_matches_rfc_4648() {
    for (plain, encoded) in [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
    ] {
        assert_eq!(base64(plain.as_bytes()), encoded, "{plain:?}");
    }
    // Every byte value, so the high bit and the last two table rows are hit.
    let all: Vec<u8> = (0..=255).collect();
    let encoded = base64(&all);
    assert_eq!(encoded.len(), 344);
    assert!(encoded.starts_with("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w=="));
}

#[test]
fn sizes_read_as_the_report_says_them() {
    assert_eq!(human(980), "980 B");
    assert_eq!(human(412_345), "412 kB");
    assert_eq!(human(3_140_000), "3.1 MB");
}

// ------------------------------------------------------------------ the route

#[test]
fn the_route_reads_the_flags_the_cli_reads() {
    assert_eq!(options("").expect("empty"), (Media::Inline, Faces::All));
    assert_eq!(
        options("media=none").expect("media"),
        (Media::None, Faces::All)
    );
    assert_eq!(
        options("faces=none&media=inline").expect("both"),
        (Media::Inline, Faces::None)
    );
    assert!(
        options("MEDIA=None").is_err(),
        "names are exact; values are not"
    );
    assert_eq!(
        options("media=None").expect("case"),
        (Media::None, Faces::All)
    );

    let bad = options("media=bogus").expect_err("refused");
    assert!(bad.contains("inline or none"), "{bad}");
    let unknown = options("wat=1").expect_err("refused");
    assert!(unknown.contains("no option \"wat\""), "{unknown}");
}

#[test]
fn the_download_is_named_however_the_vault_is() {
    assert_eq!(
        attachment("vault-2026-09-05.html"),
        "attachment; filename=\"vault-2026-09-05.html\""
    );
    assert_eq!(
        attachment("a\"b\\c.html"),
        "attachment; filename=\"a\\\"b\\\\c.html\"",
        "the quote and the backslash are escaped, not dropped"
    );
    assert_eq!(
        attachment("Notes — 2026.html"),
        "attachment; filename=\"Notes___2026.html\"; filename*=UTF-8''Notes%20%E2%80%94%202026.html"
    );
    // A control character cannot end the header line.
    let hostile = attachment("x\r\nSet-Cookie: a=b.html");
    assert!(
        !hostile.contains('\r') && !hostile.contains('\n'),
        "{hostile}"
    );
    assert!(hostile.contains("%0D%0A"), "{hostile}");
}

// ---------------------------------------------------------------- the two ends

#[test]
fn the_payload_id_is_the_one_the_client_reads() {
    // One id, spelled on both sides of the wire. `offline.ts` finds the block by
    // it; a rename on either side would produce an export that opens empty.
    let client = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/app/src/core/offline.ts"
    ))
    .expect("offline.ts");
    assert!(
        client.contains(&format!("PAYLOAD_ID = '{PAYLOAD_ID}'")),
        "offline.ts spells the id differently from {PAYLOAD_ID:?}"
    );
}

#[test]
fn the_template_forbids_every_connection() {
    // The claim the README makes for an export — it cannot phone home — is a
    // line in the template, and this holds it there.
    assert!(TEMPLATE.contains("connect-src 'none'"));
    assert!(TEMPLATE.contains("default-src 'none'"));
    assert!(!TEMPLATE.contains("http://"));
    assert!(!TEMPLATE.contains("https://"));
    for slot in [
        "{{TITLE}}",
        "{{BOOT}}",
        "{{CSS}}",
        "{{ID}}",
        "{{PAYLOAD}}",
        "{{JS}}",
    ] {
        assert!(TEMPLATE.contains(slot), "{slot} is not in the template");
    }
}

#[test]
fn the_chrome_alone_fits_the_budget() {
    // §06: the export's chrome — the UI and its faces, no notes — is budgeted
    // so a one-note export is not a megabyte. Needs the built bundle, which
    // CI's server job does not have; the e2e job holds the same line against
    // the real binary, and this one says so rather than passing quietly.
    let Ok(reader) = Reader::embedded() else {
        eprintln!("SKIPPED the_chrome_alone_fits_the_budget: no UI bundled");
        return;
    };
    let tmp = TempVault::new();
    scaffold::init(tmp.path(), false).expect("scaffold");
    let rendered = render(&tmp.open(), &reader, Media::None, Faces::All, at(0)).expect("render");

    assert!(
        rendered.html.len() <= 800_000,
        "the chrome is {} — §06 allows 800 kB",
        human(rendered.html.len())
    );
    assert!(rendered.html.contains("url(data:font/woff2;base64,"));
    assert!(!rendered.html.contains("url(/fonts/"));
}
