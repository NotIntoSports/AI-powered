pub const PARSER_UTF8: &str = "utf8-plain-v1";
pub const PARSER_PDF: &str = "pdf-extract-0.12.0";
pub const PARSER_DOCX: &str = "docx-rs-0.4.22";

pub const MEDIA_PLAIN: &str = "text/plain";
pub const MEDIA_MARKDOWN: &str = "text/markdown";
pub const MEDIA_PDF: &str = "application/pdf";
pub const MEDIA_DOCX: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    NotUtf8,
    NoTextLayer,
    ParseFailed,
}

pub fn parser_version(media_kind: &str) -> &'static str {
    match media_kind {
        MEDIA_PDF => PARSER_PDF,
        MEDIA_DOCX => PARSER_DOCX,
        _ => PARSER_UTF8,
    }
}

pub fn extract_text(media_kind: &str, bytes: &[u8]) -> Result<String, ParseError> {
    match media_kind {
        MEDIA_PLAIN | MEDIA_MARKDOWN => {
            String::from_utf8(bytes.to_vec()).map_err(|_| ParseError::NotUtf8)
        }
        MEDIA_PDF => extract_pdf(bytes),
        MEDIA_DOCX => extract_docx(bytes),
        _ => Err(ParseError::ParseFailed),
    }
}

fn extract_pdf(bytes: &[u8]) -> Result<String, ParseError> {
    let text = pdf_extract::extract_text_from_mem(bytes).map_err(|_| ParseError::ParseFailed)?;
    if text.trim().is_empty() {
        Err(ParseError::NoTextLayer)
    } else {
        Ok(text)
    }
}

fn extract_docx(bytes: &[u8]) -> Result<String, ParseError> {
    let docx = docx_rs::read_docx(bytes).map_err(|_| ParseError::ParseFailed)?;
    let mut text = String::new();
    for child in docx.document.children {
        if let docx_rs::DocumentChild::Paragraph(paragraph) = child {
            append_paragraph_text(&mut text, &paragraph);
        }
    }
    if text.trim().is_empty() {
        Err(ParseError::NoTextLayer)
    } else {
        Ok(text)
    }
}

fn append_paragraph_text(text: &mut String, paragraph: &docx_rs::Paragraph) {
    let start = text.len();
    for child in &paragraph.children {
        if let docx_rs::ParagraphChild::Run(run) = child {
            for run_child in &run.children {
                if let docx_rs::RunChild::Text(value) = run_child {
                    text.push_str(&value.text);
                }
            }
        }
    }
    if text.len() > start {
        text.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MEDIA_DOCX, MEDIA_MARKDOWN, MEDIA_PDF, MEDIA_PLAIN, ParseError, extract_text,
        parser_version,
    };
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<u8> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/materials")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
    }

    #[test]
    fn extract_utf8_plain_and_markdown() {
        assert_eq!(
            extract_text(MEDIA_PLAIN, "工作经历\n".as_bytes()).unwrap(),
            "工作经历\n"
        );
        assert_eq!(
            extract_text(MEDIA_MARKDOWN, "# 标题".as_bytes()).unwrap(),
            "# 标题"
        );
        assert_eq!(
            extract_text(MEDIA_PLAIN, &[0xff, 0xfe, 0x00]).unwrap_err(),
            ParseError::NotUtf8
        );
        assert_eq!(parser_version(MEDIA_PLAIN), "utf8-plain-v1");
        assert_eq!(parser_version(MEDIA_MARKDOWN), "utf8-plain-v1");
    }

    #[test]
    fn extract_chinese_tounicode_pdf() {
        let text = extract_text(MEDIA_PDF, &fixture("chinese-tounicode.pdf")).unwrap();
        assert!(
            text.contains("工作经历"),
            "expected ToUnicode CJK, got {text:?}"
        );
        assert_eq!(parser_version(MEDIA_PDF), "pdf-extract-0.12.0");
    }

    #[test]
    fn extract_scanned_pdf_is_no_text_layer() {
        assert_eq!(
            extract_text(MEDIA_PDF, &fixture("scanned-image-only.pdf")).unwrap_err(),
            ParseError::NoTextLayer
        );
    }

    #[test]
    fn extract_encrypted_pdf_is_parse_failed() {
        assert_eq!(
            extract_text(MEDIA_PDF, &fixture("encrypted-stub.pdf")).unwrap_err(),
            ParseError::ParseFailed
        );
    }

    #[test]
    fn extract_corrupt_pdf_is_parse_failed() {
        assert_eq!(
            extract_text(MEDIA_PDF, &fixture("corrupt-truncated.pdf")).unwrap_err(),
            ParseError::ParseFailed
        );
    }

    #[test]
    fn extract_chinese_docx() {
        let text = extract_text(MEDIA_DOCX, &fixture("chinese-synthetic.docx")).unwrap();
        assert!(text.contains("工作经历"), "got {text:?}");
        assert!(text.contains("示例科技"), "got {text:?}");
        assert_eq!(parser_version(MEDIA_DOCX), "docx-rs-0.4.22");
    }

    #[test]
    fn extract_garbage_docx_is_parse_failed() {
        assert_eq!(
            extract_text(MEDIA_DOCX, &fixture("corrupt-not-zip.docx")).unwrap_err(),
            ParseError::ParseFailed
        );
    }

    #[test]
    fn extract_empty_incomplete_docx_is_parse_failed() {
        assert_eq!(
            extract_text(MEDIA_DOCX, &fixture("empty-text.docx")).unwrap_err(),
            ParseError::ParseFailed
        );
    }
}
