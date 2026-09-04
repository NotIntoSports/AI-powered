import { routeIds, routeLabel, type RouteId } from "../app/routes";

export interface AppNavProps {
  current: RouteId;
  onNavigate: (id: RouteId) => void;
}

export function AppNav({ current, onNavigate }: AppNavProps) {
  return (
    <nav className="app-nav" aria-label="主导航">
      {routeIds.map((id) => {
        const isActive = id === current;
        return (
          <button
            key={id}
            type="button"
            className="app-nav-item"
            aria-current={isActive ? "page" : undefined}
            data-active={isActive ? "true" : undefined}
            onClick={() => {
              if (!isActive) onNavigate(id);
            }}
          >
            {routeLabel(id)}
          </button>
        );
      })}
    </nav>
  );
}
