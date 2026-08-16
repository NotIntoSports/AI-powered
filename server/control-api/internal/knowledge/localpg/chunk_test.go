package localpg

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestChunkResumeKeepsWholeJobBlock(t *testing.T) {
	text := `工作经历
2019.03-2021.06 阿里巴巴 高级工程师
负责订单服务与 Kafka 链路，使用 Node.js 完成 2019.03 版本升级。
日常维护 Vue.js 与 v1.2 配置，数值约 3.14。`
	chunks := ChunkResume("张三", text)
	if len(chunks) != 1 {
		t.Fatalf("chunks=%d contents=%v", len(chunks), contents(chunks))
	}
	if !strings.Contains(chunks[0].Content, "Node.js") || !strings.Contains(chunks[0].Content, "2019.03 版本") {
		t.Fatalf("job body was split: %q", chunks[0].Content)
	}
	if !strings.HasPrefix(chunks[0].Content, "[张三 | 工作经历 | 2019.03-2021.06 阿里巴巴 高级工程师]") {
		t.Fatalf("prefix=%q", chunks[0].Content)
	}
}

func TestChunkResumeSplitsOnDateLinesOnly(t *testing.T) {
	text := `工作经历
2019.03-2021.06 阿里巴巴
负责 Node.js 与 2019.03 内部版本。
2021.07-至今 腾讯
负责 Kafka 订单链路。`
	chunks := ChunkResume("李四", text)
	if len(chunks) != 2 {
		t.Fatalf("chunks=%d contents=%v", len(chunks), contents(chunks))
	}
	if !strings.Contains(chunks[0].Content, "阿里巴巴") || strings.Contains(chunks[0].Content, "腾讯") {
		t.Fatalf("first chunk=%q", chunks[0].Content)
	}
	if !strings.Contains(chunks[1].Content, "腾讯") {
		t.Fatalf("second chunk=%q", chunks[1].Content)
	}
}

func TestChunkResumeSplitsOversizedByBulletsWithRepeatedPrefix(t *testing.T) {
	body := strings.Repeat("职责说明", 280)
	text := "工作经历\n2018.01-2019.01 某公司\n• " + body + "\n• " + body
	chunks := ChunkResume("王五", text)
	if len(chunks) < 2 {
		t.Fatalf("expected bullet split, got %d: %v", len(chunks), contents(chunks))
	}
	for _, chunk := range chunks {
		if utf8.RuneCountInString(chunk.Content) > maxChunkRunes {
			t.Fatalf("chunk exceeded safety valve: %d", utf8.RuneCountInString(chunk.Content))
		}
		if !strings.Contains(chunk.Content, "[王五 | 工作经历 | 2018.01-2019.01 某公司]") {
			t.Fatalf("missing repeated prefix: %q", chunk.Content)
		}
	}
}

func TestChunkResumeWithoutHeadingsUsesBlankLinesNotSlidingWindow(t *testing.T) {
	text := "第一段公司经历内容。\n\n第二段项目经历内容。"
	chunks := ChunkResume("赵六", text)
	if len(chunks) != 2 {
		t.Fatalf("chunks=%d contents=%v", len(chunks), contents(chunks))
	}
	joined := strings.Join(contents(chunks), "\n")
	if strings.Contains(joined, strings.Repeat("第一段", 2)) {
		t.Fatal("blank-line fallback overlapped like a sliding window")
	}
}

func contents(chunks []Chunk) []string {
	out := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		out = append(out, chunk.Content)
	}
	return out
}
