// tests/utils.rs

use musicfeed::utils::compact_html;

#[test]
fn collapses_newlines_between_tags() {
    // Arrange — a pretty-printed fragment, which is what the templates now produce
    let fragment = "<li>\n  <p>Sabaton</p>\n  <p>Attero Dominatus</p>\n</li>";

    // Act
    let compacted = compact_html(fragment);

    // Assert — one line, no stray whitespace runs, content intact
    assert_eq!(
        compacted,
        "<li> <p>Sabaton</p> <p>Attero Dominatus</p> </li>"
    );
    assert!(!compacted.contains('\n'));
}

#[test]
fn collapses_whitespace_inside_a_tag() {
    // Arrange — attributes spread over several lines
    let fragment = "<img\n  src=\"a.jpg\"\n  alt=\"cover\"\n/>";

    // Act
    let compacted = compact_html(fragment);

    // Assert — the tag is on one line too
    assert_eq!(compacted, "<img src=\"a.jpg\" alt=\"cover\" />");
}

#[test]
fn preserves_meaningful_spacing_inside_text() {
    // Assert — a word gap must survive; collapsing to `twowords` would be a bug
    assert_eq!(
        compact_html("<p>two words   spaced</p>"),
        "<p>two words spaced</p>"
    );
    assert_eq!(
        compact_html("<p>A co-worker turned me on</p>"),
        "<p>A co-worker turned me on</p>"
    );
}

#[test]
fn trims_leading_and_trailing_whitespace() {
    assert_eq!(compact_html("   <p>lead</p>   "), "<p>lead</p>");
}

#[test]
fn already_compact_input_is_unchanged() {
    // Arrange — the single-line form must be a fixed point, or every render changes bytes
    let fragment = "<li id=\"rotation-0\"><p>Sabaton</p></li>";

    // Act / Assert
    assert_eq!(compact_html(fragment), fragment);
}

#[test]
fn output_never_contains_a_line_break() {
    // Arrange — the property the SSE encoder actually depends on
    let fragment = "<li>\n  {% if x %}\n    <p>a</p>\n  {% endif %}\n</li>";

    // Act
    let compacted = compact_html(fragment);

    // Assert
    assert!(
        !compacted.contains('\n') && !compacted.contains('\r'),
        "compacted output still has line breaks: {compacted:?}"
    );
}
