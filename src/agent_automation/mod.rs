mod companion;
mod store;

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
    MAX_GOAL_BYTES, PAIRING_REFERENCE_TTL_MS, PairingIssue, PairingState, SelectionState,
};
