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
	"github.com/ai-interviewer/ai-powered/control-api/internal/httpapi"
	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
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
	defer pool.Close()
	if err := database.Migrate(context.Background(), pool); err != nil {
		log.Fatalf("migrate database: %v", err)
	}
	authentication, err := httpapi.NewDatabaseAuthentication(pool, cfg.SessionTTL)
	if err != nil {
		log.Fatal("initialize authentication service")
	}

	server := &http.Server{
		Addr: cfg.ListenAddress,
		Handler: httpapi.NewRouter(httpapi.Dependencies{
			Authentication:    authentication,
			UserAdmin:         identity.NewService(pool),
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
