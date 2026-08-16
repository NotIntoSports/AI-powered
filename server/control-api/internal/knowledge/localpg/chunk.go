package localpg

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	maxChunkRunes     = 2000
	hardSplitLookback = 400
	maxChunks         = 500
)

var (
	phonePattern    = regexp.MustCompile(`(?:\+?86[- ]?)?1[3-9]\d{9}`)
	emailPattern    = regexp.MustCompile(`[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}`)
	blankParagraphs = regexp.MustCompile(`\n\s*\n+`)
	dateLine        = regexp.MustCompile(`(?i)^\d{4}([./\-年])\d{1,2}月?(?:\s*[-–—至到]+\s*(?:\d{4}([./\-年])\d{1,2}月?|至今|现在|present))?`)
	bulletLine      = regexp.MustCompile(`^([•·●○■\-*、]|（\d+）|\(\d+\)|\d+[\.、])\s*`)
)

var sectionHeadings = []string{
	"工作经历", "工作经验", "实习经历", "项目经历", "项目经验",
	"教育背景", "教育经历", "专业技能", "技能特长", "自我评价", "个人总结",
	"experience", "work experience", "projects", "education", "skills", "summary",
}

type Chunk struct {
	Index   int
	Content string
}

func ChunkResume(candidateName, text string) []Chunk {
	cleaned := cleanText(text)
	if strings.TrimSpace(cleaned) == "" {
		return nil
	}
	sections := splitSections(cleaned)
	var raw []string
	for _, section := range sections {
		raw = append(raw, splitSection(candidateName, section.heading, section.body)...)
	}
	if len(raw) == 0 {
		raw = splitOversized(cleaned)
	}
	chunks := make([]Chunk, 0, len(raw))
	for _, content := range raw {
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		chunks = append(chunks, Chunk{Index: len(chunks), Content: content})
		if len(chunks) >= maxChunks {
			break
		}
	}
	return chunks
}

type section struct {
	heading string
	body    string
}

func cleanText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = phonePattern.ReplaceAllString(text, "")
	text = emailPattern.ReplaceAllString(text, "")
	lines := strings.Split(text, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if utf8.RuneCountInString(line) < 2 {
			if strings.TrimSpace(line) == "" {
				kept = append(kept, "")
			}
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func splitSections(text string) []section {
	lines := strings.Split(text, "\n")
	var sections []section
	current := section{heading: "", body: ""}
	flush := func() {
		body := strings.TrimSpace(current.body)
		if body == "" {
			return
		}
		sections = append(sections, section{heading: current.heading, body: body})
	}
	for _, line := range lines {
		if heading, ok := matchHeading(line); ok {
			flush()
			current = section{heading: heading, body: ""}
			continue
		}
		if current.body != "" {
			current.body += "\n"
		}
		current.body += line
	}
	flush()
	if len(sections) == 0 && strings.TrimSpace(text) != "" {
		return []section{{heading: "", body: strings.TrimSpace(text)}}
	}
	return sections
}

func matchHeading(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	trimmed = strings.Trim(trimmed, "：:")
	normalized := strings.ToLower(trimmed)
	for _, heading := range sectionHeadings {
		if normalized == strings.ToLower(heading) {
			return heading, true
		}
	}
	return "", false
}

func splitSection(candidate, heading, body string) []string {
	if isExperienceHeading(heading) {
		return chunkBlocks(candidate, heading, splitExperienceBlocks(body))
	}
	if heading == "" {
		blocks := splitBlankParagraphs(body)
		if len(blocks) <= 1 {
			items := splitBulletItems(body)
			if len(items) > 1 {
				blocks = items
			}
		}
		return chunkBlocks(candidate, heading, blocks)
	}
	title := firstLineTitle(body)
	prefixed := withPrefix(candidate, heading, title, body)
	return splitOversized(prefixed)
}

func chunkBlocks(candidate, heading string, blocks []string) []string {
	var out []string
	for _, block := range blocks {
		title := firstLineTitle(block)
		prefixed := withPrefix(candidate, heading, title, block)
		out = append(out, splitOversized(prefixed)...)
	}
	return out
}

func splitBlankParagraphs(body string) []string {
	parts := blankParagraphs.Split(body, -1)
	var blocks []string
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			blocks = append(blocks, part)
		}
	}
	if len(blocks) == 0 && strings.TrimSpace(body) != "" {
		return []string{strings.TrimSpace(body)}
	}
	return blocks
}

func isExperienceHeading(heading string) bool {
	switch strings.ToLower(heading) {
	case "工作经历", "工作经验", "实习经历", "项目经历", "项目经验", "experience", "work experience", "projects":
		return true
	default:
		return false
	}
}

func splitExperienceBlocks(body string) []string {
	lines := strings.Split(body, "\n")
	var blocks []string
	var current []string
	flush := func() {
		text := strings.TrimSpace(strings.Join(current, "\n"))
		if text != "" {
			blocks = append(blocks, text)
		}
		current = nil
	}
	for _, line := range lines {
		if dateLine.MatchString(strings.TrimSpace(line)) && len(current) > 0 {
			flush()
		}
		current = append(current, line)
	}
	flush()
	if len(blocks) == 0 && strings.TrimSpace(body) != "" {
		return []string{strings.TrimSpace(body)}
	}
	return blocks
}

func firstLineTitle(block string) string {
	line := strings.TrimSpace(strings.Split(block, "\n")[0])
	if utf8.RuneCountInString(line) > 80 {
		return string([]rune(line)[:80])
	}
	return line
}

func withPrefix(candidate, heading, title, body string) string {
	label := strings.TrimSpace(strings.Join([]string{candidate, heading, title}, " | "))
	label = strings.Trim(label, " |")
	if label == "" {
		return strings.TrimSpace(body)
	}
	return "[" + label + "]\n" + strings.TrimSpace(body)
}

func splitOversized(text string) []string {
	if utf8.RuneCountInString(text) <= maxChunkRunes {
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return []string{text}
	}
	body := text
	prefix := ""
	if strings.HasPrefix(text, "[") {
		if idx := strings.Index(text, "]\n"); idx >= 0 {
			prefix = text[:idx+2]
			body = text[idx+2:]
		}
	}
	items := splitBulletItems(body)
	if len(items) > 1 {
		var out []string
		for _, item := range items {
			out = append(out, splitOversized(strings.TrimSpace(prefix+item))...)
		}
		return out
	}
	return hardSplit(text, prefix)
}

func splitBulletItems(body string) []string {
	lines := strings.Split(body, "\n")
	var items []string
	var current []string
	flush := func() {
		text := strings.TrimSpace(strings.Join(current, "\n"))
		if text != "" {
			items = append(items, text)
		}
		current = nil
	}
	found := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if bulletLine.MatchString(trimmed) && len(current) > 0 {
			found = true
			flush()
		}
		current = append(current, line)
	}
	flush()
	if !found {
		return nil
	}
	return items
}

func hardSplit(text, prefix string) []string {
	runes := []rune(text)
	var out []string
	start := 0
	for start < len(runes) {
		remaining := runes[start:]
		if len(remaining) <= maxChunkRunes {
			piece := strings.TrimSpace(string(remaining))
			if start > 0 && prefix != "" && !strings.HasPrefix(piece, "[") {
				piece = strings.TrimSpace(prefix + piece)
			}
			if piece != "" {
				out = append(out, piece)
			}
			break
		}
		window := remaining
		if len(window) > maxChunkRunes {
			window = remaining[:maxChunkRunes]
		}
		cut := findSplit(window)
		if cut <= 0 {
			cut = maxChunkRunes
		}
		piece := strings.TrimSpace(string(remaining[:cut]))
		if start > 0 && prefix != "" && !strings.HasPrefix(piece, "[") {
			piece = strings.TrimSpace(prefix + piece)
		}
		if piece != "" {
			out = append(out, piece)
		}
		start += cut
	}
	return out
}

func findSplit(window []rune) int {
	if len(window) == 0 {
		return 0
	}
	begin := 0
	if len(window) > hardSplitLookback {
		begin = len(window) - hardSplitLookback
	}
	for i := len(window) - 1; i >= begin; i-- {
		if window[i] == '\n' {
			if i+1 < len(window) && window[i+1] == '\n' {
				return i + 2
			}
			return i + 1
		}
	}
	for i := len(window) - 1; i >= begin; i-- {
		if window[i] == '。' || window[i] == '！' || window[i] == '？' {
			if i > 0 && window[i-1] == window[i] {
				continue
			}
			return i + 1
		}
	}
	return 0
}
