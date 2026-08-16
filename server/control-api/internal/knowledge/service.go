package knowledge

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

const defaultIndexTimeout = 5 * time.Minute

type ResumeStore interface {
	BeginIndex(ctx context.Context, resumeID string) (resumes.Record, bool, error)
	FinishIndex(ctx context.Context, resumeID, status, errorText, provider, externalDocID string) error
	ResetIndex(ctx context.Context, resumeID string) error
	GetAccessible(ctx context.Context, actor users.User, resumeID string) (resumes.Record, error)
}

type Service struct {
	db       database.DBTX
	resumes  ResumeStore
	provider Provider
	parent   context.Context
	timeout  time.Duration
	audit    *audit.Store
}

func NewService(parent context.Context, db database.DBTX, resumeStore ResumeStore, provider Provider) *Service {
	if parent == nil {
		parent = context.Background()
	}
	svc := &Service{
		db:       db,
		resumes:  resumeStore,
		provider: provider,
		parent:   parent,
		timeout:  defaultIndexTimeout,
	}
	if db != nil {
		svc.audit = audit.NewStore(db)
	}
	return svc
}

func (s *Service) ProviderName() string {
	if s == nil || s.provider == nil {
		return ProviderLocalPGVector
	}
	return s.provider.Name()
}

func (s *Service) EnqueueIndex(resumeID, actorUserID, requestID string) {
	if s == nil || s.provider == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(s.parent, s.timeout)
		defer cancel()
		_ = s.Index(ctx, resumeID, actorUserID, requestID)
	}()
}

func (s *Service) Index(ctx context.Context, resumeID, actorUserID, requestID string) error {
	record, started, err := s.resumes.BeginIndex(ctx, resumeID)
	if err != nil {
		return err
	}
	if !started {
		return nil
	}
	outcome, err := s.provider.Index(ctx, IndexJob{
		ResumeID:      record.ID,
		CandidateName: record.CandidateName,
		ObjectKey:     record.ObjectKey,
		Filename:      record.OriginalFilename,
		ContentType:   record.ContentType,
	})
	status := StatusReady
	errorText := ""
	if errors.Is(err, ErrSkipped) {
		status = StatusSkipped
		errorText = sanitizeIndexError(err)
	} else if errors.Is(err, ErrNoText) {
		status = StatusFailed
		errorText = "no extractable text (scanned?)"
	} else if err != nil {
		status = StatusFailed
		errorText = sanitizeIndexError(err)
		log.Printf("knowledge index failed resume=%s: %v", resumeID, err)
	}
	finishErr := s.resumes.FinishIndex(ctx, resumeID, string(status), errorText, s.provider.Name(), outcome.ExternalDocID)
	result := audit.ResultSuccess
	if status != StatusReady {
		result = audit.ResultFailure
	}
	if s.audit != nil {
		_ = s.audit.Append(ctx, audit.Event{
			ActorUserID: actorUserID,
			Action:      audit.ActionResumeIndexed,
			TargetType:  "resume",
			TargetID:    resumeID,
			Result:      result,
			RequestID:   requestID,
			Metadata: map[string]any{
				"indexStatus": string(status),
				"chunkCount":  outcome.ChunkCount,
			},
		})
	}
	if finishErr != nil {
		return finishErr
	}
	if status == StatusFailed {
		return err
	}
	return nil
}

func (s *Service) Reindex(ctx context.Context, actor users.User, requestID, resumeID string) error {
	record, err := s.resumes.GetAccessible(ctx, actor, resumeID)
	if err != nil {
		return err
	}
	_ = s.provider.Delete(ctx, record.ID, record.ExternalDocID)
	if err := s.resumes.ResetIndex(ctx, record.ID); err != nil {
		return err
	}
	if s.audit != nil {
		_ = s.audit.Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionResumeReindexed,
			TargetType:  "resume",
			TargetID:    resumeID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
		})
	}
	s.EnqueueIndex(record.ID, actor.ID, requestID)
	return nil
}

func (s *Service) DeleteDocument(ctx context.Context, resumeID, externalDocID string) error {
	if s == nil || s.provider == nil {
		return nil
	}
	return s.provider.Delete(ctx, resumeID, externalDocID)
}

func (s *Service) Status(ctx context.Context, actor users.User, resumeID string) (resumes.Record, error) {
	return s.resumes.GetAccessible(ctx, actor, resumeID)
}

func (s *Service) Search(ctx context.Context, actor users.User, in SearchInput) SearchResult {
	normalized, err := NormalizeSearch(in)
	if err != nil {
		return EmptyResult()
	}
	record, err := s.resumes.GetAccessible(ctx, actor, normalized.ResumeID)
	if err != nil || record.IndexStatus != string(StatusReady) {
		return EmptyResult()
	}
	normalized.ExternalDocID = record.ExternalDocID
	result, err := s.provider.Search(ctx, normalized)
	if err != nil {
		log.Printf("knowledge search failed resume=%s: %v", normalized.ResumeID, err)
		return EmptyResult()
	}
	if result.Chunks == nil {
		result.Chunks = []Chunk{}
	}
	return result
}

func sanitizeIndexError(err error) string {
	if err == nil {
		return ""
	}
	text := strings.TrimSpace(err.Error())
	text = strings.ReplaceAll(text, "http://", "")
	text = strings.ReplaceAll(text, "https://", "")
	if utf8.RuneCountInString(text) > 300 {
		runes := []rune(text)
		text = string(runes[:300])
	}
	return text
}
