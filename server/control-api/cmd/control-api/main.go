package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/config"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/embeddings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/httpapi"
	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge"
	"github.com/ai-interviewer/ai-powered/control-api/internal/knowledge/localpg"
	"github.com/ai-interviewer/ai-powered/control-api/internal/presence"
	"github.com/ai-interviewer/ai-powered/control-api/internal/resumes"
	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}

	pool, err := database.Open(context.Background(), cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	if err := database.Migrate(context.Background(), pool); err != nil {
		pool.Close()
		log.Fatalf("migrate database: %v", err)
	}
	pool, err = database.ReopenWithVector(context.Background(), cfg.DatabaseURL, pool)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer pool.Close()

	providerName, err := knowledge.NormalizeProviderName(cfg.KnowledgeProvider)
	if err != nil {
		log.Fatal(err)
	}

	authentication, err := httpapi.NewDatabaseAuthentication(pool, cfg.SessionTTL)
	if err != nil {
		log.Fatal("initialize authentication service")
	}

	var box *secretbox.Box
	if len(cfg.SettingsMasterKey) > 0 {
		box, err = secretbox.New(cfg.SettingsMasterKey)
		if err != nil {
			log.Fatal("initialize settings encryption")
		}
	}

	resumeAdmin := resumes.NewService(pool, box, nil)
	var knowledgeAdmin httpapi.KnowledgeAdmin
	switch providerName {
	case knowledge.ProviderLocalPGVector:
		knowledgeAdmin = knowledge.NewService(
			context.Background(),
			pool,
			resumeAdmin,
			localpg.New(pool, embeddings.NewClient(cfg.EmbeddingBaseURL, cfg.EmbeddingModel), resumeAdmin.FetchObject),
		)
	default:
		log.Fatal(knowledge.ErrUnknownProvider)
	}

	server := &http.Server{
		Addr:              cfg.ListenAddress,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       60 * time.Second,
		Handler: httpapi.NewRouter(httpapi.Dependencies{
			Authentication:    authentication,
			UserAdmin:         identity.NewService(pool),
			SettingsAdmin:     settings.NewService(pool, box, nil),
			PresenceAdmin:     presence.NewStore(pool),
			ResumeAdmin:       resumeAdmin,
			KnowledgeAdmin:    knowledgeAdmin,
			SessionTTL:        cfg.SessionTTL,
			CookieSecure:      cfg.CookieSecure,
			TrustedProxyCIDRs: cfg.TrustedProxyCIDRs,
		}),
	}
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
		return
	case <-signals:
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
}
