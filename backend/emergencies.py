"""Deterministic emergency catalog and auditable mitigation workflow."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

try:
    from .navigation import AirportCatalog
    from .schemas import (
        EmergencyAction,
        EmergencyState,
        ResolutionCriterion,
        Severity,
    )
except ImportError:  # pragma: no cover
    from navigation import AirportCatalog
    from schemas import EmergencyAction, EmergencyState, ResolutionCriterion, Severity


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class EmergencyDefinition:
    type: str
    title: str
    severity: Severity
    summary: str
    alert: str
    squawk: str
    steps: tuple[tuple[str, str, str, str], ...]
    requires_landing: bool
    effects: dict[str, float]


def _step(category: str, title: str, instruction: str, rationale: str) -> tuple[str, str, str, str]:
    return category, title, instruction, rationale


EMERGENCY_CATALOG: dict[str, EmergencyDefinition] = {
    "engine_failure": EmergencyDefinition(
        "engine_failure", "Engine failure", Severity.CRITICAL,
        "Loss of thrust from one or more engines; preserve control and landing options.",
        "MAYDAY — engine failure. Priority return/diversion and rescue services required.", "7700",
        (
            _step("stabilize", "Fly the aircraft", "Set a safe single-engine attitude and airspeed; apply operative-engine thrust and trim.", "Control and energy state come before diagnosis."),
            _step("navigate", "Protect a landing option", "Stop the climb if performance is marginal and turn only after a safe airspeed is established.", "Avoid an unrecoverable low-energy state."),
            _step("communicate", "Declare MAYDAY", "Transmit nature of emergency, position, altitude, souls, fuel, and intentions; squawk 7700.", "ATC can clear traffic and prepare the runway."),
            _step("divert", "Accept suitable runway", "Use the recommended nearby suitable airport or explicitly choose a safer alternate.", "Minimize exposure time while respecting aircraft capability."),
            _step("land", "Single-engine landing", "Configure deliberately, use the applicable checklist, and land without unnecessary delay.", "Landing ends exposure to the failed propulsion system."),
        ), True, {"max_speed_kts": 230.0},
    ),
    "medical": EmergencyDefinition(
        "medical", "Medical emergency", Severity.WARNING,
        "A person onboard needs time-critical medical assistance.",
        "PAN/MAYDAY medical — priority diversion requested; medical team to meet aircraft.", "7700",
        (
            _step("stabilize", "Start onboard care", "Cabin crew assess the patient, provide first aid/AED/oxygen, and seek qualified medical help onboard.", "Immediate care continues while diversion is planned."),
            _step("navigate", "Review time-to-care", "Compare destination and suitable diversion times, weather, runway, and handling capability.", "Fastest safe access to care is the objective."),
            _step("communicate", "Declare medical priority", "Tell ATC the medical condition, requested airport, and assistance required on arrival.", "ATC and airport responders need actionable information."),
            _step("divert", "Commit to diversion", "Proceed direct to the selected suitable airport and coordinate cabin preparation.", "A clear decision prevents avoidable delay."),
            _step("land", "Priority arrival", "Fly a stable approach; land and taxi to the agreed medical meeting point.", "A rushed unstable approach creates a second emergency."),
        ), True, {"max_speed_kts": 340.0},
    ),
    "hydraulic": EmergencyDefinition(
        "hydraulic", "Hydraulic failure", Severity.CRITICAL,
        "Degraded flight controls, brakes, steering, flaps, or gear may affect handling and landing distance.",
        "MAYDAY — hydraulic failure. Long runway and emergency services required.", "7700",
        (
            _step("stabilize", "Assess controllability", "Maintain a safe configuration and confirm which hydraulic systems and controls remain available.", "Configuration changes may be irreversible."),
            _step("navigate", "Choose a long runway", "Prefer favorable weather, a long runway, and minimal maneuvering.", "Landing distance and directional control may be degraded."),
            _step("communicate", "Declare handling limits", "Advise ATC of controllability, gear/flap/brake status, and runway requirements.", "ATC needs the real operational constraint."),
            _step("divert", "Set up a shallow arrival", "Allow extra track miles and avoid tight vectors or unnecessary configuration changes.", "A deliberate setup protects control margin."),
            _step("land", "Use abnormal landing checklist", "Fly the calculated approach speed, plan stopping/evacuation, and do not vacate until able.", "Braking and steering can be limited."),
        ), True, {"max_speed_kts": 220.0},
    ),
    "bird_strike": EmergencyDefinition(
        "bird_strike", "Bird strike", Severity.WARNING,
        "Possible engine, windshield, sensor, or structure damage after a bird impact.",
        "Bird strike — assess damage; priority return available.", "7700",
        (
            _step("stabilize", "Maintain control", "Hold a safe attitude and airspeed; avoid abrupt thrust or configuration changes until damage is assessed.", "Secondary effects may not be immediately obvious."),
            _step("navigate", "Remain within landing range", "Level off or return if engine indications, visibility, or flight controls are affected.", "Damage can worsen under load."),
            _step("communicate", "Report strike and damage", "Advise ATC of impact, suspected damage, position, altitude, and intentions.", "The runway and following traffic may also need inspection."),
            _step("divert", "Choose inspection landing", "Return/divert when damage is suspected; otherwise follow the operator checklist.", "A ground inspection is the reliable damage assessment."),
            _step("land", "Plan precautionary landing", "Use a stable approach and have emergency services inspect the aircraft after stopping.", "Hidden engine or structural damage remains possible."),
        ), True, {"max_speed_kts": 240.0},
    ),
    "fuel": EmergencyDefinition(
        "fuel", "Fuel emergency", Severity.CRITICAL,
        "Usable fuel is below the safe plan or predicted landing reserve.",
        "MAYDAY FUEL — immediate priority route to the nearest suitable landing airport.", "7700",
        (
            _step("stabilize", "Confirm usable fuel", "Cross-check tanks, imbalance, leak indications, endurance, and the fuel checklist.", "A bad indication and an actual leak require different actions."),
            _step("navigate", "Minimize time airborne", "Proceed by the shortest safe route and avoid holding.", "Remaining endurance is the dominant constraint."),
            _step("communicate", "Declare MAYDAY FUEL", "State fuel endurance in minutes, souls onboard, and the requested runway; squawk 7700.", "Minimum fuel alone does not guarantee priority; MAYDAY FUEL does."),
            _step("divert", "Commit to nearest suitable", "Accept the closest suitable runway unless weather or runway limits make it unsafe.", "Late changes consume the remaining reserve."),
            _step("land", "Priority landing", "Configure on schedule, fly a stable approach, and land without delay.", "A go-around may be unavailable."),
        ), True, {"max_speed_kts": 300.0},
    ),
    "comm_failure": EmergencyDefinition(
        "comm_failure", "Communication failure", Severity.WARNING,
        "Two-way radio communication is unavailable or unreliable.",
        "Radio failure — squawk 7600 and follow published lost-communication procedure.", "7600",
        (
            _step("stabilize", "Troubleshoot radios", "Check volume/squelch, audio panel, frequency, headset, circuit protection, and the second radio.", "Simple configuration faults are common."),
            _step("navigate", "Follow last clearance", "Maintain the last acknowledged route and altitude, then apply the published lost-communications procedure.", "Predictable flight lets ATC protect airspace."),
            _step("communicate", "Use alternate channels", "Squawk 7600, transmit blind, try 121.5/data link, and watch for light signals when relevant.", "ATC may receive even when you cannot."),
            _step("divert", "Select a predictable arrival", "Continue or divert only as the applicable procedure and safety require.", "Unexpected maneuvering increases conflict risk."),
            _step("land", "Complete no-radio arrival", "Observe signals/traffic, fly the published procedure, and clear the runway promptly when safe.", "The arrival remains an operational risk until stopped."),
        ), False, {},
    ),
    "smoke_fire": EmergencyDefinition(
        "smoke_fire", "Smoke or fire", Severity.CRITICAL,
        "Smoke or fire can rapidly make the aircraft uncontrollable or uninhabitable.",
        "MAYDAY — smoke/fire. Immediate descent and nearest suitable landing required.", "7700",
        (
            _step("stabilize", "Oxygen and memory items", "Don oxygen masks, establish crew communication, and execute the applicable smoke/fire memory items.", "Time to incapacitation or structural damage may be short."),
            _step("navigate", "Descend and turn toward landing", "Start the safest immediate descent and route to the nearest suitable runway.", "Landing time matters more than schedule or convenience."),
            _step("communicate", "Declare MAYDAY", "State smoke/fire location, position, altitude, souls, fuel, and immediate landing intention.", "ATC must clear the shortest route and alert rescue services."),
            _step("divert", "Land at nearest suitable", "Commit to the nearest runway that can be reached safely; do not delay for diagnosis.", "An uncontained fire is time-critical."),
            _step("land", "Land and evacuate", "Land as soon as possible, stop where responders can access the aircraft, and evacuate if required.", "The emergency is not over until occupants are safe."),
        ), True, {"target_altitude_ft": 10000.0, "max_speed_kts": 320.0},
    ),
    "gear": EmergencyDefinition(
        "gear", "Landing gear malfunction", Severity.WARNING,
        "Landing gear indication, extension, or locking is abnormal.",
        "Gear malfunction — priority handling, inspection pass, and emergency services requested.", "7700",
        (
            _step("stabilize", "Maintain safe configuration", "Level off if needed, respect gear/flap speed limits, and complete the abnormal indication checks.", "Overspeed or cycling can worsen damage."),
            _step("navigate", "Create troubleshooting space", "Remain near a suitable airport with fuel and altitude for the alternate extension procedure.", "The crew needs time without losing the landing option."),
            _step("communicate", "Report gear status", "Tell ATC which gear is unsafe/unknown and request a low approach if useful.", "Responders and tower can prepare and observe."),
            _step("divert", "Choose suitable runway", "Prefer a long runway with favorable wind and rescue capability.", "Directional control and stopping may be degraded."),
            _step("land", "Abnormal gear landing", "Complete alternate extension, brief evacuation, fly a stable approach, and stop the aircraft.", "The fault is only safely contained on the ground."),
        ), True, {"max_speed_kts": 190.0},
    ),
}


class EmergencyManager:
    def __init__(self):
        self.active: EmergencyState | None = None
        self._definition: EmergencyDefinition | None = None

    @property
    def catalog(self) -> dict[str, dict]:
        return {
            key: {
                "type": definition.type,
                "title": definition.title,
                "severity": definition.severity.value,
                "summary": definition.summary,
                "requires_landing": definition.requires_landing,
            }
            for key, definition in EMERGENCY_CATALOG.items()
        }

    def activate(
        self,
        kind: str,
        state: dict,
        catalog: AirportCatalog,
        details: str | None = None,
    ) -> EmergencyState:
        definition = EMERGENCY_CATALOG[kind]
        now = _now()
        nearest = catalog.nearest(float(state["lat"]), float(state["lon"]))
        actions = [
            EmergencyAction(
                action_id=f"{kind}:{category}",
                category=category,
                priority=index,
                title=title,
                instruction=instruction,
                rationale=rationale,
            )
            for index, (category, title, instruction, rationale) in enumerate(definition.steps, start=1)
        ]
        summary = definition.summary if not details else f"{definition.summary} Reported detail: {details}"
        self._definition = definition
        self.active = EmergencyState(
            emergency_id=str(uuid.uuid4()),
            type=kind,
            title=definition.title,
            severity=definition.severity,
            status="active",
            declared_at=now,
            summary=summary,
            alert_message=definition.alert,
            squawk=definition.squawk,
            recommended_diversion=nearest,
            actions=actions,
            resolution_criteria=[],
            can_resolve=False,
        )
        state["squawk"] = definition.squawk
        self.refresh(state)
        return self.active.model_copy(deep=True)

    def effects(self) -> dict[str, float]:
        if self.active is None or self.active.status == "resolved" or self._definition is None:
            return {}
        return dict(self._definition.effects)

    def complete_action(self, action_id: str, completed: bool, state: dict) -> EmergencyState:
        if self.active is None or self.active.status == "resolved":
            raise LookupError("No active emergency.")
        found = False
        now = _now()
        updated: list[EmergencyAction] = []
        for action in self.active.actions:
            if action.action_id == action_id:
                found = True
                updated.append(action.model_copy(update={
                    "completed": completed,
                    "completed_at": now if completed else None,
                }))
            else:
                updated.append(action)
        if not found:
            raise KeyError(action_id)
        self.active = self.active.model_copy(update={"actions": updated})
        self.refresh(state)
        return self.active.model_copy(deep=True)

    def refresh(self, state: dict) -> EmergencyState | None:
        if self.active is None or self._definition is None:
            return None
        required_actions = all(action.completed for action in self.active.actions if action.required)
        landing_ok = bool(state.get("on_ground")) if self._definition.requires_landing else True
        criteria = [
            ResolutionCriterion(
                criterion_id="required_actions_complete",
                description="All required stabilize, navigate, communicate, divert, and land actions are complete.",
                satisfied=required_actions,
            )
        ]
        if self._definition.requires_landing:
            criteria.append(ResolutionCriterion(
                criterion_id="aircraft_on_ground",
                description="Aircraft is safely on the ground.",
                satisfied=landing_ok,
            ))
        can_resolve = all(item.satisfied for item in criteria)
        status = self.active.status
        if status != "resolved":
            status = "mitigating" if any(action.completed for action in self.active.actions) else "active"
        self.active = self.active.model_copy(update={
            "resolution_criteria": criteria,
            "can_resolve": can_resolve,
            "status": status,
        })
        return self.active.model_copy(deep=True)

    def resolve(self, state: dict, force: bool = False) -> EmergencyState:
        if self.active is None:
            raise LookupError("No active emergency.")
        self.refresh(state)
        assert self.active is not None
        if not self.active.can_resolve and not force:
            raise PermissionError("Emergency resolution criteria are not yet satisfied.")
        self.active = self.active.model_copy(update={
            "status": "resolved",
            "resolved_at": _now(),
            "can_resolve": True,
        })
        if state.get("squawk") in {"7700", "7600"}:
            state["squawk"] = "2000"
        return self.active.model_copy(deep=True)

    def reset(self) -> None:
        self.active = None
        self._definition = None

