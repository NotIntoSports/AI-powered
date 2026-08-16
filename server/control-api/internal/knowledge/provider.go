package knowledge

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	ProviderLocalPGVector = "local-pgvector"

	DefaultTopK   = 5
	MinTopK       = 1
	MaxTopK       = 10
	MaxQueryRunes = 2000
	MinQueryRunes = 1
)

var (
	ErrUnknownProvider = errors.New("unknown knowledge provider")
	ErrSkipped         = errors.New("resume cannot be indexed")
	ErrNoText          = errors.New("no extractable text")
	ErrInvalidSearch   = errors.New("invalid knowledge search")
)

type Provider interface {
	Name() string
	Index(ctx context.Context, job IndexJob) (IndexOutcome, error)
	Search(ctx context.Context, in SearchInput) (SearchResult, error)
	Delete(ctx context.Context, resumeID, externalDocID string) error
}

type IndexJob struct {
	ResumeID      string
	CandidateName string
	ObjectKey     string
	Filename      string
	ContentType   string
}

type IndexOutcome struct {
	ExternalDocID string
	ChunkCount    int
}

type SearchInput struct {
	Query         string
	ResumeID      string
	ExternalDocID string
	TopK          int
}

type Chunk struct {
	Content       string  `json:"content"`
	Score         float64 `json:"score"`
	CandidateName string  `json:"candidateName"`
}

type SearchResult struct {
	Chunks []Chunk `json:"chunks"`
}

type IndexStatus string

const (
	StatusPending  IndexStatus = "pending"
	StatusIndexing IndexStatus = "indexing"
	StatusReady    IndexStatus = "ready"
	StatusFailed   IndexStatus = "failed"
	StatusSkipped  IndexStatus = "skipped"
)

func NormalizeProviderName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return ProviderLocalPGVector, nil
	}
	if name == ProviderLocalPGVector {
		return name, nil
	}
	return "", ErrUnknownProvider
}

func NormalizeSearch(in SearchInput) (SearchInput, error) {
	in.Query = strings.TrimSpace(in.Query)
	in.ResumeID = strings.TrimSpace(in.ResumeID)
	in.ExternalDocID = strings.TrimSpace(in.ExternalDocID)
	if in.Query == "" || utf8.RuneCountInString(in.Query) > MaxQueryRunes {
		return SearchInput{}, ErrInvalidSearch
	}
	if in.ResumeID == "" {
		return SearchInput{}, ErrInvalidSearch
	}
	if in.TopK == 0 {
		in.TopK = DefaultTopK
	}
	if in.TopK < MinTopK || in.TopK > MaxTopK {
		return SearchInput{}, ErrInvalidSearch
	}
	return in, nil
}

func EmptyResult() SearchResult {
	return SearchResult{Chunks: []Chunk{}}
}
