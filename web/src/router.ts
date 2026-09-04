/**
 * A ~40-line router. There are five routes, and pulling in a routing library for
 * five would add more bundle and API surface than it removes.
 *
 * The reason routes exist at all rather than one stateful page: A REPORT URL MUST
 * SURVIVE A REFRESH. `/report/:id` re-fetches the stored report, and
 * `/analysis/:jobId` reconnects to a run already in flight rather than starting a
 * new one. A single-page app with no URLs would make "share this result"
 * impossible and would restart the analysis on every reload.
 */
import { useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "scan" }
  | { name: "analysis"; jobId: string }
  | { name: "report"; reportId: string }
  | { name: "saved" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "analysis" && parts[1]) return { name: "analysis", jobId: parts[1] };
  if (parts[0] === "report" && parts[1]) return { name: "report", reportId: parts[1] };
  if (parts[0] === "scan") return { name: "scan" };
  if (parts[0] === "saved") return { name: "saved" };
  return { name: "home" };
}

export function toPath(route: Route): string {
  switch (route.name) {
    case "analysis":
      return `/analysis/${route.jobId}`;
    case "report":
      return `/report/${route.reportId}`;
    case "scan":
      return "/scan";
    case "saved":
      return "/saved";
    default:
      return "/";
  }
}

export function navigate(route: Route): void {
  history.pushState({}, "", toPath(route));
  // pushState does not fire popstate, so the app would not re-render without
  // this. A custom event keeps the subscription in one place.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  return route;
}
