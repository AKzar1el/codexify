mod companion;
mod store;
mod supervisor;

pub use companion::{
    ActionPrompt, BrowserCompanionClient, COMPANION_KIND, CancelActionReceipt, CapabilityCatalog,
    CompanionActionSnapshot, CompanionActionState, CompanionAttention, CompanionEvent,
    CompanionEventKind, CompanionHealth, CompanionSelection, CompanionSessionStatus,
    CompanionUnreadMessage, EffortCapability, ExecuteActionRequest, ModelCapability,
    PROTOCOL_VERSION, RevealWindowReceipt, RevealWindowRequest,
};
pub use store::{
    AgentAutomationStore, AutomationActionKind, AutomationActionState, AutomationActionStatus,
    AutomationTaskState, ChatMirrorState, GoalFinish, GoalRecord, GoalStatus, GoalWakeState,
    MAX_GOAL_BYTES, OwnerGoalCommand, OwnerGoalCommandKind, OwnerGoalCommandReceipt,
    PAIRING_REFERENCE_TTL_MS, PairingIssue, PairingState, SelectionState,
};
pub use supervisor::{
    AgentAutomationSupervisor, AutomationExecution, AutomationExecutionError, AutomationExecutor,
    AutomationLiveState, AutomationSupervisorWorker, AutomationTaskHandle,
    BrowserAutomationExecutor, PairingCommit,
};
