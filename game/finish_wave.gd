extends RefCounted

# A cohort is identified when the player presses the button. Packed
# replenishment stays off throughout; boss summons after admission are
# native and never enter the initial identity ledger.
const CAST_PERIOD := 0.55
const LIMIT := 45.0
var owner
var game
var packed
var optimized := false
var id := 0
var status := ""
var started_at := 0.0
var elapsed := 0.0
var next_cast := 0.0
var before := 0
var initial_packed := 0
var initial_species := {}
var initial_packed_species := {}
var signature := ""
var native_left := {}
var native_left_by_kind := {}
var native_killed := 0
var native_killed_by_kind := {}
var vanished := 0
var native_xp := 0.0
var added := 0
var added_killed := 0
var casts := 0
var base_packed_kills := 0
var base_packed_xp := 0
var settled := {}
var vanished_by_kind := {}

func setup(scene, source_game, cohort, use_packed: bool) -> void:
	owner = scene
	game = source_game
	packed = cohort
	optimized = use_packed

func begin(command: int, audit: Dictionary) -> void:
	if status == "running":
		return
	id = command
	status = "running"
	settled.clear()
	native_left.clear()
	native_left_by_kind.clear()
	vanished_by_kind.clear()
	initial_species = audit.species.duplicate()
	initial_packed_species = JSON.parse_string(str(packed.composition())) if optimized else {}
	before = int(audit["count"])
	signature = audit.ids
	initial_packed = int(packed.auditLiveCount()) if optimized else 0
	base_packed_kills = game.pulse_kills if optimized else 0
	base_packed_xp = game.xp_dropped if optimized else 0
	native_killed = 0
	native_killed_by_kind.clear()
	native_xp = 0.0
	vanished = 0
	added = 0
	added_killed = 0
	casts = 0
	started_at = game.t
	elapsed = 0.0
	for actor in game.enemies:
		if not actor.dead and not actor.boss and Data.ENEMIES.has(actor.kind):
			native_left[actor.get_instance_id()] = actor.kind
			native_left_by_kind[actor.kind] = int(native_left_by_kind.get(actor.kind, 0)) + 1
	if before > 0:
		_cast()
	_update()

func _cast() -> void:
	casts += 1
	owner.deal_full_field()
	next_cast = game.t + CAST_PERIOD

func tick() -> void:
	if status != "running":
		return
	_update()
	if status == "running" and game.t >= next_cast:
		_cast()
		_update()

func _update() -> void:
	elapsed = game.t - started_at
	var remaining := native_left.size() + (int(packed.aliveCount()) if optimized else 0)
	if remaining == 0:
		var actual_kills: int = native_killed + (game.pulse_kills - base_packed_kills if optimized else 0)
		if actual_kills + vanished != before:
			_stop("unreconciled")
		else:
			_stop("withDepartures" if vanished > 0 else "complete")
	elif elapsed >= LIMIT:
		_stop("timeout")

func cancel() -> void:
	if status == "running":
		elapsed = game.t - started_at
		_stop("cancelled")

func _stop(result: String) -> void:
	status = result
	settled = _read()
	native_left.clear()

func _retire(actor) -> bool:
	var key: int = actor.get_instance_id()
	if not native_left.has(key):
		return false
	var family: String = native_left[key]
	native_left.erase(key)
	native_left_by_kind[family] -= 1
	return true

func native_spawned(actor) -> void:
	if status == "running" and not actor.boss and Data.ENEMIES.has(actor.kind):
		added += 1

func native_combat_death(actor) -> bool:
	if status != "running" or actor.boss or not Data.ENEMIES.has(actor.kind):
		return false
	if _retire(actor):
		native_killed += 1
		native_killed_by_kind[actor.kind] = int(native_killed_by_kind.get(actor.kind, 0)) + 1
		return true
	added_killed += 1
	return false

func native_departed(actor) -> void:
	if status == "running" and _retire(actor):
		vanished += 1
		vanished_by_kind[actor.kind] = int(vanished_by_kind.get(actor.kind, 0)) + 1

func snapshot() -> Dictionary:
	if id == 0:
		return {}
	return _read() if status == "running" else settled

func _read() -> Dictionary:
	var survivors: Dictionary = JSON.parse_string(str(packed.composition())) if optimized else {}
	var killed_by_kind := native_killed_by_kind.duplicate()
	for family in initial_packed_species:
		var defeated := int(initial_packed_species[family]) - int(survivors.get(family, 0))
		if defeated > 0:
			killed_by_kind[family] = int(killed_by_kind.get(family, 0)) + defeated
	for family in native_left_by_kind:
		if native_left_by_kind[family] > 0:
			survivors[family] = int(survivors.get(family, 0)) + int(native_left_by_kind[family])
	var packed_kills: int = game.pulse_kills - base_packed_kills if optimized else 0
	var packed_xp: int = game.xp_dropped - base_packed_xp if optimized else 0
	var remaining := native_left.size() + (int(packed.auditLiveCount()) if optimized else 0)
	return {"id": id, "status": status, "before": before, "initialPacked": initial_packed,
		"killed": native_killed + packed_kills, "vanished": vanished, "nativeKilled": native_killed,
		"packedKilled": packed_kills, "remaining": remaining,
		"accounted": native_killed + packed_kills + vanished + remaining,
		"cohortVerified": native_killed + packed_kills + vanished + remaining == before,
		"xpAwarded": native_xp + packed_xp, "casts": casts, "elapsed": elapsed, "liveIdsBefore": signature,
		"survivorsByKind": survivors, "killedByKind": killed_by_kind, "vanishedByKind": vanished_by_kind.duplicate(),
		"speciesBefore": initial_species, "newSpawned": added, "newKilled": added_killed,
		"radius": 768, "minimumDamage": 64, "period": CAST_PERIOD, "timeLimit": LIMIT}
