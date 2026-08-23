// Command control-api-mcp serves user and session administration of the
// control API as a Model Context Protocol service over Streamable HTTP.
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
	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/mcpadmin"
	"github.com/ai-interviewer/ai-powered/control-api/internal/presence"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

func main() {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	if cfg.MCPAdminToken == "" {
		log.Fatal(config.ErrMCPAdminTokenRequired)
	}
	if cfg.MCPActorUsername == "" {
		log.Fatal(config.ErrMCPActorUsernameRequired)
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

	mcpServer := mcpadmin.NewServer(mcpadmin.Dependencies{
		Identity:      identity.NewService(pool),
		Presence:      presence.NewStore(pool),
		Users:         users.NewStore(pool),
		ActorUsername: cfg.MCPActorUsername,
	})

	server := &http.Server{
		Addr:              cfg.MCPListenAddress,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		// WriteTimeout is intentionally unset: Streamable HTTP keeps
		// long-lived SSE streams open for server-initiated messages.
		IdleTimeout: 60 * time.Second,
		Handler:     mcpServer.Handler(cfg.MCPAdminToken),
	}
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()
	log.Printf("control-api-mcp listening on %s", cfg.MCPListenAddress)

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
