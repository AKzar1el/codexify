//! Plain-text labels for Markdown-derived and custom conversation titles.
use pulldown_cmark::{Event, Options, Parser, TagEnd};

pub(super) fn plain_text(markdown: &str, limit: usize) -> String {
    let mut output = String::new();
    let mut length = 0;
    let mut space = false;
    let mut append = |text: &str| {
        for ch in text.chars() {
            if ch.is_whitespace() {
                space = length > 0;
                continue;
            }
            if space {
                if length >= limit {
                    return false;
                }
                output.push(' ');
                length += 1;
                space = false;
            }
            if length >= limit {
                return false;
            }
            output.push(ch);
            length += 1;
        }
        length < limit
    };
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    for event in Parser::new_ext(markdown, options) {
        let more = match event {
            Event::Text(text) | Event::Code(text) | Event::Html(text) | Event::InlineHtml(text) => {
                append(&text)
            }
            Event::SoftBreak | Event::HardBreak | Event::Rule => append(" "),
            Event::End(end)
                if !matches!(
                    end,
                    TagEnd::Emphasis
                        | TagEnd::Strong
                        | TagEnd::Strikethrough
                        | TagEnd::Link
                        | TagEnd::Image
                ) =>
            {
                append(" ")
            }
            _ => true,
        };
        if !more {
            break;
        }
    }
    output.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markdown_but_preserves_the_readable_content() {
        for (markdown, expected) in [
            (
                "**It should not require a major redesign.**",
                "It should not require a major redesign.",
            ),
            (
                "## A **bold** and *useful* title",
                "A bold and useful title",
            ),
            (
                "__Strong__ with _emphasis_ and ~~old wording~~",
                "Strong with emphasis and old wording",
            ),
            (
                "Use `session.sh` and [the guide](https://example.com/guide)",
                "Use session.sh and the guide",
            ),
            (
                "> - [x] Review the fix\n> - Ship it",
                "Review the fix Ship it",
            ),
            ("```rust\nlet done = true;\n```", "let done = true;"),
            (
                "![Build diagram](https://example.com/private.png)",
                "Build diagram",
            ),
            ("# Header\n\n---\n\nNext paragraph", "Header Next paragraph"),
            ("| One | Two |\n| --- | --- |\n| A | B |", "One Two A B"),
            ("Fish &amp; chips", "Fish & chips"),
        ] {
            assert_eq!(plain_text(markdown, 200), expected, "{markdown}");
        }
    }

    #[test]
    fn preserves_literal_symbols_and_escaped_markdown() {
        for title in [
            "C# and C++: my_project/file_name, 2 * 3 = 6, issue #42",
            "Use std::vector<int> and Vec<String>",
            "https://example.com/my_project/file_name?q=a_b",
            "Read the [unresolved reference]",
        ] {
            assert_eq!(plain_text(title, 200), title);
        }
        assert_eq!(
            plain_text(r"\*literal\* and \_name\_", 200),
            "*literal* and _name_"
        );
        assert_eq!(
            plain_text("`**literal syntax**`", 200),
            "**literal syntax**"
        );
    }

    #[test]
    fn normalizes_before_truncating_without_splitting_unicode() {
        assert_eq!(plain_text("**Hello**   world", 7), "Hello w");
        assert_eq!(plain_text("# **你好世界**", 3), "你好世");
        assert_eq!(plain_text("**Hello**", 0), "");
        assert_eq!(plain_text("---", 72), "");
        assert_eq!(plain_text("  \n\t ", 72), "");
    }
}
