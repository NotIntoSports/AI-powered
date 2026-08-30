package settings

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestParseTokenPlanPersonalCatalog(t *testing.T) {
	html := `<h2 id="支持的模型">支持的模型</h2><table><tr><td>qwen3.8-flash</td><td>文本生成、推理模型、视觉理解</td></tr><tr><td>qwen-image-3.0-pro</td><td>图片生成</td></tr><tr><td>qwen-audio-3.0-asr-flash</td><td>语音识别</td></tr><tr><td>qwen-audio-3.0-tts-plus</td><td>语音合成</td></tr><tr><td>qwen-audio-3.0-realtime-plus</td><td>Realtime-Chatting</td></tr><tr><td>wan2.7-image-pro</td><td>图片生成</td></tr><tr><td>happyhorse-1.1-t2v</td><td>视频生成</td></tr></table><h2>其他</h2>`
	models, _, err := ParseTokenPlanPersonalCatalog(strings.NewReader(html))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"qwen3.8-flash": "llm", "qwen-image-3.0-pro": "image", "qwen-audio-3.0-asr-flash": "asr",
		"qwen-audio-3.0-tts-plus": "tts", "qwen-audio-3.0-realtime-plus": "e2e", "wan2.7-image-pro": "image", "happyhorse-1.1-t2v": "video",
	}
	if len(models) != len(want) {
		t.Fatalf("models = %#v", models)
	}
	for _, model := range models {
		if want[model.ModelID] != model.Capability {
			t.Fatalf("%s capability = %s", model.ModelID, model.Capability)
		}
	}
}

func TestParseTokenPlanPersonalCatalogRejectsEmptyOrChangedPage(t *testing.T) {
	if _, _, err := ParseTokenPlanPersonalCatalog(strings.NewReader(`<html>no supported model table</html>`)); err == nil {
		t.Fatal("expected structure error")
	}
}

func TestParseCurrentTokenPlanPersonalCatalog(t *testing.T) {
	if os.Getenv("TOKEN_PLAN_LIVE_TEST") != "1" {
		t.Skip("set TOKEN_PLAN_LIVE_TEST=1 for the public official-page smoke test")
	}
	response, err := http.Get(TokenPlanPersonalCatalogURL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	models, _, err := ParseTokenPlanPersonalCatalog(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) < 10 {
		t.Fatalf("official models = %d, want at least 10", len(models))
	}
}
