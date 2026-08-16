package knowledge

import (
	"context"
	"errors"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

type fakeResumeStore struct {
	record      resumes.Record
	beginStart  bool
	resetCalled bool
}

func (f *fakeResumeStore) BeginIndex(context.Context, string) (resumes.Record, bool, error) {
	return f.record, f.beginStart, nil
}

func (f *fakeResumeStore) FinishIndex(context.Context, string, string, string, string, string) error {
	return nil
}

func (f *fakeResumeStore) ResetIndex(context.Context, string) error {
	f.resetCalled = true
	f.record.IndexStatus = string(StatusPending)
	return nil
}

func (f *fakeResumeStore) GetAccessible(context.Context, users.User, string) (resumes.Record, error) {
	return f.record, nil
}

type fakeProvider struct {
	indexErr  error
	searchErr error
	deleted   int
	indexed   int
	chunks    []Chunk
}

func (f *fakeProvider) Name() string { return ProviderLocalPGVector }

func (f *fakeProvider) Index(context.Context, IndexJob) (IndexOutcome, error) {
	f.indexed++
	if f.indexErr != nil {
		return IndexOutcome{}, f.indexErr
	}
	return IndexOutcome{ChunkCount: 3}, nil
}

func (f *fakeProvider) Search(context.Context, SearchInput) (SearchResult, error) {
	if f.searchErr != nil {
		return SearchResult{}, f.searchErr
	}
	return SearchResult{Chunks: f.chunks}, nil
}

func (f *fakeProvider) Delete(context.Context, string, string) error {
	f.deleted++
	return nil
}

func TestSearchReturnsEmptyWhenNotReady(t *testing.T) {
	store := &fakeResumeStore{record: resumes.Record{ID: "r1", IndexStatus: string(StatusPending)}}
	provider := &fakeProvider{chunks: []Chunk{{Content: "secret", Score: 0.9}}}
	svc := NewService(context.Background(), nil, store, provider)
	result := svc.Search(context.Background(), users.User{ID: "u1"}, SearchInput{Query: "经历", ResumeID: "r1", TopK: 5})
	if len(result.Chunks) != 0 {
		t.Fatalf("chunks=%v", result.Chunks)
	}
}

func TestSearchReturnsEmptyWhenProviderFails(t *testing.T) {
	store := &fakeResumeStore{record: resumes.Record{ID: "r1", IndexStatus: string(StatusReady)}}
	provider := &fakeProvider{searchErr: errors.New("embedding down")}
	svc := NewService(context.Background(), nil, store, provider)
	result := svc.Search(context.Background(), users.User{ID: "u1"}, SearchInput{Query: "经历", ResumeID: "r1", TopK: 5})
	if result.Chunks == nil || len(result.Chunks) != 0 {
		t.Fatalf("chunks=%v", result.Chunks)
	}
}

func TestReindexDeletesThenResets(t *testing.T) {
	store := &fakeResumeStore{record: resumes.Record{ID: "r1", IndexStatus: string(StatusFailed)}, beginStart: true}
	provider := &fakeProvider{}
	svc := NewService(context.Background(), nil, store, provider)
	if err := svc.Reindex(context.Background(), users.User{ID: "u1"}, "req-1", "r1"); err != nil {
		t.Fatal(err)
	}
	if provider.deleted != 1 {
		t.Fatalf("deleted=%d", provider.deleted)
	}
	if !store.resetCalled {
		t.Fatal("reset not called")
	}
}

func TestNormalizeProviderNameRejectsUnknown(t *testing.T) {
	_, err := NormalizeProviderName("ragflow")
	if !errors.Is(err, ErrUnknownProvider) {
		t.Fatalf("err=%v", err)
	}
}
