package localpg

import (
	"context"
	"fmt"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
	"github.com/pgvector/pgvector-go"
)

const (
	sourceResume   = "resume"
	minSearchScore = 0.45
)

type chunkStore struct {
	db database.DBTX
}

func (s *chunkStore) Replace(ctx context.Context, resumeID, candidateName, model string, chunks []Chunk, vectors [][]float32) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		delete from knowledge_chunks
		where source_type = $1 and source_id = $2
	`, sourceResume, resumeID); err != nil {
		return err
	}
	now := time.Now().UTC()
	for index, chunk := range chunks {
		if index >= len(vectors) {
			return fmt.Errorf("embedding count mismatch")
		}
		if _, err := tx.Exec(ctx, `
			insert into knowledge_chunks (
				source_type, source_id, chunk_index, content, embedding, embedding_model, candidate_name, created_at
			) values ($1,$2,$3,$4,$5,$6,$7,$8)
		`, sourceResume, resumeID, chunk.Index, chunk.Content, pgvector.NewVector(vectors[index]), model, candidateName, now); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *chunkStore) Delete(ctx context.Context, resumeID string) error {
	_, err := s.db.Exec(ctx, `
		delete from knowledge_chunks
		where source_type = $1 and source_id = $2
	`, sourceResume, resumeID)
	return err
}

func (s *chunkStore) Search(ctx context.Context, resumeIDs []string, embedding []float32, topK int) ([]knowledge.Chunk, error) {
	if len(resumeIDs) == 0 {
		return []knowledge.Chunk{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select content, 1 - (embedding <=> $1) as score, candidate_name
		from knowledge_chunks
		where source_type = $2 and source_id = any($3)
		order by embedding <=> $1
		limit $4
	`, pgvector.NewVector(embedding), sourceResume, resumeIDs, topK)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]knowledge.Chunk, 0)
	for rows.Next() {
		var chunk knowledge.Chunk
		if err := rows.Scan(&chunk.Content, &chunk.Score, &chunk.CandidateName); err != nil {
			return nil, err
		}
		if chunk.Score < minSearchScore {
			continue
		}
		result = append(result, chunk)
	}
	return result, rows.Err()
}
