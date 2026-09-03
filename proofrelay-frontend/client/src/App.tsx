// Evidence Ledger design: navigation is explicit and each operational area has its own page.
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import ActivityLog from "./pages/ActivityLog";
import Artifacts from "./pages/Artifacts";
import NotFound from "./pages/NotFound";
import Overview from "./pages/Overview";
import ProtocolDocs from "./pages/ProtocolDocs";
import TaskDetail from "./pages/TaskDetail";
import VerificationTasks from "./pages/VerificationTasks";
import VerifierNetwork from "./pages/VerifierNetwork";

function Router() {
  return <Switch>
    <Route path="/" component={Overview} />
    <Route path="/verification-tasks" component={VerificationTasks} />
    <Route path="/verifier-network" component={VerifierNetwork} />
    <Route path="/artifacts" component={Artifacts} />
    <Route path="/activity-log" component={ActivityLog} />
    <Route path="/protocol-docs" component={ProtocolDocs} />
    <Route path="/task/:taskId" component={TaskDetail} />
    <Route path="/404" component={NotFound} />
    <Route component={NotFound} />
  </Switch>;
}

export default function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="light"><TooltipProvider><Toaster position="top-right" /><Router /></TooltipProvider></ThemeProvider></ErrorBoundary>;
}
