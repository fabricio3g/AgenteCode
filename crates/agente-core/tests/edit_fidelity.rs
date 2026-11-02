//! Edit fidelity: the corpus that decides whether the matcher is honest.
//!
//! Two kinds of assertion, and the second is the one that matters:
//!
//! 1. **Outcome** — each realistic model mistake either applies with the
//!    documented tolerance, or is refused with the reason.
//! 2. **Invariant** — an accepted edit lands on the intended line range, and a
//!    refusal writes nothing. A matcher that "succeeds" in the wrong place is
//!    worse than one that fails, so the property test at the bottom mutates a
//!    file at random and insists the edit lands on that line or not at all.
//!
//! Every failure shape here came from a real session or a documented provider
//! behaviour (see `AGENTS.md`), not from imagination.

use agente_core::tools::edit_match::{apply, line_of, locate, EditMatch, MatchLevel};

enum Expect {
    /// Matches, at this tolerance, on this 1-based line.
    Found { level: &'static str, line: usize },
    /// More than one candidate at this tolerance: refuse, never guess.
    Ambiguous,
    /// No tolerance applies: refuse.
    NotFound,
}

struct Case {
    name: &'static str,
    file: &'static str,
    old: &'static str,
    new: &'static str,
    /// The whole file after the edit (only read for accepted cases).
    after: &'static str,
    expect: Expect,
}

fn found(level: &'static str, line: usize) -> Expect {
    Expect::Found { level, line }
}

fn corpus() -> Vec<Case> {
    Vec::from([
        Case {
            name: "exact text",
            file: "fn a() {\n    one();\n}\n",
            old: "    one();",
            new: "    two();",
            after: "fn a() {\n    two();\n}\n",
            expect: found("exact", 2),
        },
        Case {
            name: "trailing whitespace the model added",
            file: "fn a() {\n    one();\n}\n",
            old: "    one();   ",
            new: "    two();",
            after: "fn a() {\n    two();\n}\n",
            expect: found("trailing whitespace", 2),
        },
        Case {
            name: "indentation retyped as two spaces, only one line real",
            file: "fn a() {\n    one();\n}\n",
            old: "  one();\n  two();",
            new: "  three();",
            after: "",
            // `two()` is not there: only the first line matches, so this is a
            // miss rather than a partial line-level edit — see the next case.
            expect: Expect::NotFound,
        },
        Case {
            name: "indentation drift on a block that exists",
            file: "fn a() {\n    one();\n    two();\n}\n",
            old: "  one();\n  two();",
            new: "  three();",
            after: "fn a() {\n  three();\n}\n",
            expect: found("whitespace", 2),
        },
        Case {
            name: "tabs where the file has spaces",
            file: "fn a() {\n\tone();\n}\n",
            old: "    one();",
            new: "    two();",
            after: "fn a() {\n    two();\n}\n",
            expect: found("whitespace", 2),
        },
        Case {
            name: "CRLF file, LF old text",
            file: "fn a() {\r\n    one();\r\n}\r\n",
            old: "    one();",
            new: "    two();",
            after: "fn a() {\r\n    two();\r\n}\r\n",
            // The old text is a substring of the line, so the byte search wins
            // before any line tolerance is needed — and the CRLF around it is
            // preserved by `apply`.
            expect: found("exact", 2),
        },
        Case {
            name: "smart quotes in a line fragment",
            file: "let note = \u{201C}done\u{201D};\n",
            old: "let note = \"done\";",
            new: "let note = \"ok\";",
            after: "let note = \"ok\";\n",
            expect: found("normalized", 1),
        },
        Case {
            name: "a blank line the model dropped",
            file: "fn a() {\n\n    one();\n}\n",
            old: "fn a() {\n    one();",
            new: "fn a() {\n    two();",
            after: "fn a() {\n    two();\n}\n",
            expect: found("blank-line tolerant", 1),
        },
        Case {
            name: "one line retyped inside an exact block",
            file: "fn build(items: &[Item]) -> Report {\n    let mut report = Report::new();\n    for item in items {\n        report.push(item);\n    }\n    report\n}\n",
            old: "fn build(items: &[Item]) -> Report {\n    let mut report = Report::new();\n    for entry in items {\n        report.push(item);\n    }\n    report",
            new: "fn build(items: &[Item]) -> Report {\n    let mut report = Report::new();\n    report",
            after: "fn build(items: &[Item]) -> Report {\n    let mut report = Report::new();\n    report\n}\n",
            expect: Expect::Found {
                level: "similar 92%",
                line: 1,
            },
        },
        Case {
            name: "duplicated block",
            file: "let x = 1;\nlet y = 2;\nlet x = 1;\n",
            old: "let x = 1;",
            new: "let x = 3;",
            after: "",
            expect: Expect::Ambiguous,
        },
        Case {
            name: "unrelated search",
            file: "fn a() {\n    one();\n}\n",
            old: "nothing like this exists",
            new: "x",
            after: "",
            expect: Expect::NotFound,
        },
        Case {
            name: "an abbreviated old text with an ellipsis",
            file: "fn a() {\n    one();\n    two();\n}\n",
            old: "fn a() {\n    \u{2026}\n}",
            new: "fn a() {\n    three();\n}",
            after: "",
            expect: Expect::NotFound,
        },
        Case {
            name: "multi-byte characters around the match",
            file: "// \u{65e5}\u{672c}\u{8a9e}\nfn a() {\n    one();\n}\n",
            old: "    one();",
            new: "    two();",
            after: "// \u{65e5}\u{672c}\u{8a9e}\nfn a() {\n    two();\n}\n",
            expect: found("exact", 3),
        },
        Case {
            name: "the same line in two functions is ambiguous",
            file: "fn a() {\n    run();\n}\nfn b() {\n    run();\n}\n",
            old: "    run();",
            new: "    stop();",
            after: "",
            expect: Expect::Ambiguous,
        },
    ])
}

#[test]
fn the_corpus_behaves_as_documented() {
    for case in corpus() {
        match (locate(case.file, case.old, None), case.expect) {
            (EditMatch::Found(found), Expect::Found { level, line }) => {
                assert_eq!(found.level.label(), level, "{}: tolerance", case.name);
                assert_eq!(found.line, line, "{}: line", case.name);
                assert_eq!(
                    apply(case.file, found.range.clone(), case.new),
                    case.after,
                    "{}: applied text",
                    case.name
                );
            }
            (EditMatch::Ambiguous { level, lines }, Expect::Ambiguous) => {
                assert!(lines.len() >= 2, "{}: candidates", case.name);
                assert!(!level.label().is_empty());
            }
            (EditMatch::NotFound, Expect::NotFound) => {}
            (outcome, _) => panic!(
                "{}: unexpected outcome {:?}",
                case.name,
                match outcome {
                    EditMatch::Found(f) => format!("found at {} ({})", f.line, f.level.label()),
                    EditMatch::Ambiguous { lines, .. } => format!("ambiguous at {lines:?}"),
                    EditMatch::NotFound => "not found".to_string(),
                }
            ),
        }
    }
}

#[test]
fn a_refusal_never_touches_the_file() {
    for case in corpus() {
        if matches!(case.expect, Expect::Found { .. }) {
            continue;
        }
        assert!(matches!(
            locate(case.file, case.old, None),
            EditMatch::Ambiguous { .. } | EditMatch::NotFound
        ));
        // Nothing to apply: the tool writes only after `Found`.
        assert_eq!(
            case.after, "",
            "{}: refusal case has an after text",
            case.name
        );
    }
}

#[test]
fn every_accepted_edit_covers_whole_lines() {
    for case in corpus() {
        let EditMatch::Found(found) = locate(case.file, case.old, None) else {
            continue;
        };
        // A replacement may not start or end inside a line unless the old text
        // itself was a fragment (the normalized-substring level); even then the
        // range must sit on character boundaries.
        assert!(
            case.file.is_char_boundary(found.range.start)
                && case.file.is_char_boundary(found.range.end),
            "{}: range splits a character",
            case.name
        );
        if found.level != MatchLevel::Normalized || case.old.contains('\n') {
            let before = &case.file[..found.range.start];
            let after = &case.file[found.range.end..];
            assert!(
                before.is_empty() || before.ends_with('\n'),
                "{}: edit starts mid-line",
                case.name
            );
            assert!(
                after.is_empty() || after.starts_with('\n') || after.starts_with('\r'),
                "{}: edit ends mid-line",
                case.name
            );
        }
    }
}

/// The invariant that keeps this design safe: a random retyped line either
/// applies to that line, or is refused. Never anywhere else.
#[test]
fn a_random_retyped_line_lands_on_that_line_or_is_refused() {
    let lines = 40usize;
    let file: String = (0..lines)
        .map(|i| format!("    let value_{i} = compute({i});\n"))
        .collect();
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut wrong = Vec::new();
    for _ in 0..200 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let line = (seed % lines as u64) as usize;
        // The model drops the indentation; every line is unique, so the edit
        // must resolve to that one line.
        let old = format!("let value_{line} = compute({line});");
        if let EditMatch::Found(found) = locate(&file, &old, None) {
            let hit = line_of(&file, found.range.start);
            if hit != line + 1 {
                wrong.push((line + 1, hit));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "edits landed on the wrong line: {wrong:?}"
    );
}

/// `nearLine` may only break ties: it must never move an edit to a line whose
/// text does not match.
#[test]
fn a_near_line_never_invents_a_match() {
    let file = "alpha();\nbeta();\ngamma();\n";
    assert!(matches!(
        locate(file, "delta();", Some(2)),
        EditMatch::NotFound
    ));
    // A real match stays on its own line whatever hint is passed.
    let EditMatch::Found(found) = locate(file, "gamma();", Some(1)) else {
        panic!("expected a match");
    };
    assert_eq!(found.line, 3);
}
