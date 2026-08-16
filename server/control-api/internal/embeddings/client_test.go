package embeddings

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEmbedQueryRequires1024Dimensions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		vector := make([]float32, Dimension)
		vector[0] = 0.5
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"index": 0, "embedding": vector}},
		})
	}))
	t.Cleanup(server.Close)
	client := NewClient(server.URL, "BAAI/bge-m3")
	vector, err := client.EmbedQuery(context.Background(), "订单服务")
	if err != nil {
		t.Fatal(err)
	}
	if len(vector) != Dimension {
		t.Fatalf("dim=%d", len(vector))
	}
}

func TestEmbedRejectsWrongDimension(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]any{{"index": 0, "embedding": []float32{0.1, 0.2}}},
		})
	}))
	t.Cleanup(server.Close)
	client := NewClient(server.URL, "BAAI/bge-m3")
	_, err := client.EmbedQuery(context.Background(), "订单服务")
	if err != ErrDimension {
		t.Fatalf("err=%v", err)
	}
}
