import { routeIds, routeLabel, type RouteId } from "../app/routes";
import { FolderOpen, History, MessageSquare, Radio, Settings2, SlidersHorizontal, Sparkles } from "lucide-react";

const icons: Record<RouteId, typeof MessageSquare> = { workspace: MessageSquare, livestream: Radio, materials: FolderOpen, records: History, services: SlidersHorizontal, settings: Settings2 };

export interface AppNavProps {
  current: RouteId;
  onNavigate: (id: RouteId) => void;
}

export function AppNav({ current, onNavigate }: AppNavProps) {
  function item(id: RouteId) {
    const isActive = id === current;
    const Icon = icons[id];
    return (
      <button key={id} type="button" className="app-nav-item"
        aria-current={isActive ? "page" : undefined} data-active={isActive ? "true" : undefined}
        onClick={() => { if (!isActive) onNavigate(id); }}>
        <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
        <span>{routeLabel(id)}</span>
      </button>
    );
  }
  return (
    <nav className="app-nav" aria-label="主导航">
      <div className="app-brand"><span className="brand-mark"><Sparkles size={19} aria-hidden="true" /></span><span>AI 虚拟助手</span></div>
      <div className="app-nav-primary">{routeIds.filter((id) => id !== "settings").map(item)}</div>
      <div className="app-nav-footer">{item("settings")}<p>本地工作空间</p></div>
    </nav>
  );
}
