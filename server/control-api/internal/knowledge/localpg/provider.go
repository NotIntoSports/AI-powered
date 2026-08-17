package localpg

import (
	"context"
	"fmt"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/embeddings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
)

type ObjectFetcher func(ctx context.Context, objectKey string) ([]byte, error)

type Provider struct {
	store *chunkStore
	embed *embeddings.Client
	fetch ObjectFetcher
}

func New(db database.DBTX, embed *embeddings.Client, fetch ObjectFetcher) *Provider {
	return &Provider{
		store: &chunkStore{db: db},
		embed: embed,
		fetch: fetch,
	}
}

func (p *Provider) Name() string {
	return knowledge.ProviderLocalPGVector
}

func (p *Provider) Index(ctx context.Context, job knowledge.IndexJob) (knowledge.IndexOutcome, error) {
	if p.fetch == nil {
		return knowledge.IndexOutcome{}, knowledge.ErrNoText
	}
	payload, err := p.fetch(ctx, job.ObjectKey)
	if err != nil {
		return knowledge.IndexOutcome{}, err
	}
	text, err := extractText(job.Filename, job.ContentType, payload)
	if err != nil {
		return knowledge.IndexOutcome{}, err
	}
	chunks := ChunkResume(job.CandidateName, text)
	if len(chunks) == 0 {
		return knowledge.IndexOutcome{}, knowledge.ErrNoText
	}
	inputs := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		inputs = append(inputs, chunk.Content)
	}
	vectors, err := p.embed.EmbedDocuments(ctx, inputs)
	if err != nil {
		return knowledge.IndexOutcome{}, fmt.Errorf("embed documents: %w", err)
	}
	if err := p.store.Replace(ctx, job.ResumeID, job.CandidateName, p.embed.Model(), chunks, vectors); err != nil {
		return knowledge.IndexOutcome{}, err
	}
	return knowledge.IndexOutcome{ChunkCount: len(chunks)}, nil
}

func (p *Provider) Search(ctx context.Context, in knowledge.SearchInput) (knowledge.SearchResult, error) {
	query := strings.TrimSpace(in.Query)
	vector, err := p.embed.EmbedQuery(ctx, query)
	if err != nil {
		return knowledge.EmptyResult(), err
	}
	ids := in.ResumeIDs
	if len(ids) == 0 && strings.TrimSpace(in.ResumeID) != "" {
		ids = []string{in.ResumeID}
	}
	chunks, err := p.store.Search(ctx, ids, vector, in.TopK)
	if err != nil {
		return knowledge.EmptyResult(), err
	}
	if chunks == nil {
		chunks = []knowledge.Chunk{}
	}
	return knowledge.SearchResult{Chunks: chunks}, nil
}

func (p *Provider) Delete(ctx context.Context, resumeID, _ string) error {
	return p.store.Delete(ctx, resumeID)
}

var _ knowledge.Provider = (*Provider)(nil)
