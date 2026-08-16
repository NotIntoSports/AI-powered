package embeddings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	Dimension    = 1024
	MaxBatch     = 32
	QueryTimeout = 5 * time.Second
	IndexTimeout = 30 * time.Second
)

var (
	ErrUnavailable = errors.New("embedding service unavailable")
	ErrDimension   = errors.New("unexpected embedding dimension")
)

type Client struct {
	baseURL    string
	model      string
	httpClient *http.Client
}

func NewClient(baseURL, model string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		model:   strings.TrimSpace(model),
		httpClient: &http.Client{
			Timeout: IndexTimeout,
		},
	}
}

type requestBody struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

type responseBody struct {
	Data []struct {
		Index     int       `json:"index"`
		Embedding []float32 `json:"embedding"`
	} `json:"data"`
}

func (c *Client) Embed(ctx context.Context, inputs []string, timeout time.Duration) ([][]float32, error) {
	if c.baseURL == "" || c.model == "" {
		return nil, ErrUnavailable
	}
	if len(inputs) == 0 {
		return nil, nil
	}
	if len(inputs) > MaxBatch {
		return nil, fmt.Errorf("%w: batch larger than %d", ErrUnavailable, MaxBatch)
	}
	payload, err := json.Marshal(requestBody{Model: c.model, Input: inputs})
	if err != nil {
		return nil, ErrUnavailable
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/embeddings", bytes.NewReader(payload))
	if err != nil {
		return nil, ErrUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	client := c.httpClient
	if timeout > 0 && timeout != client.Timeout {
		client = &http.Client{Timeout: timeout}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	if err != nil {
		return nil, ErrUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, ErrUnavailable
	}
	var parsed responseBody
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, ErrUnavailable
	}
	vectors := make([][]float32, len(inputs))
	for _, item := range parsed.Data {
		if item.Index < 0 || item.Index >= len(vectors) {
			return nil, ErrUnavailable
		}
		if len(item.Embedding) != Dimension {
			return nil, ErrDimension
		}
		vectors[item.Index] = item.Embedding
	}
	for _, vector := range vectors {
		if len(vector) != Dimension {
			return nil, ErrUnavailable
		}
	}
	return vectors, nil
}

func (c *Client) EmbedQuery(ctx context.Context, query string) ([]float32, error) {
	vectors, err := c.Embed(ctx, []string{query}, QueryTimeout)
	if err != nil {
		return nil, err
	}
	if len(vectors) != 1 {
		return nil, ErrUnavailable
	}
	return vectors[0], nil
}

func (c *Client) EmbedDocuments(ctx context.Context, inputs []string) ([][]float32, error) {
	all := make([][]float32, 0, len(inputs))
	for start := 0; start < len(inputs); start += MaxBatch {
		end := start + MaxBatch
		if end > len(inputs) {
			end = len(inputs)
		}
		batch, err := c.Embed(ctx, inputs[start:end], IndexTimeout)
		if err != nil {
			return nil, err
		}
		all = append(all, batch...)
	}
	return all, nil
}

func (c *Client) Model() string {
	return c.model
}
