extends Node

const OriginalGame = preload("res://review/stock_debug_game.gd")
const OptimizedGame = preload("res://review/optimized_game.gd")
const ViewSettings = preload("res://scripts/ui/ui_util.gd")
const NativeProjectile = preload("res://scripts/game/projectile.gd")
const NativeEnemy = preload("res://scripts/game/enemy.gd")
const MixedRoster = preload("res://review/mixed_roster.gd")
const WaveFinisher = preload("res://review/finish_wave.gd")
const HALF_VIEW := Vector2(320, 180)
const TELEMETRY_INTERVAL := 0.25
const CAPACITY := 100000
const BOSS_TYPES := ["daebuntang", "doebaebot", "buffering", "glitch", "stairs", "blizzard", "macaron", "bookworm", "bat", "returnbox"]

var bridge
var game
var optimized := false
var mixed := false
var roster
var bulk_keys: Array = []
var catalog: Array = []
var native_species_spawned: Dictionary = {}
var native_elite_spawned: Dictionary = {}
var finisher
var pending_finish := 0
var heart_spawned := 0
var casting_boss
var selected_boss
var pattern_initial_state := ""
var pattern_initial_zones := 0
var pattern_output := 0
var native_events: Dictionary = {}
var pattern_details: Dictionary = {}
var shot_floor := 0
var floor_ticks := 0
var floor_min := -1
var initializing_mix := false
var resume_fill_after_clear := false
var hold_clear := false
var suppressed_summons: Array = []
var mode := "original"
var target_count := CAPACITY
var scenario_seed := 7
var cohort
var phase := "spawning"
var ticks := 0
var elapsed := 0.0
var next_report := 0.0
var last_health := 0.0
var hits_taken := 0
var damage_taken := 0.0
var recoveries := 0
var last_updated := 0
var next_input := 0.0
var command_id := 0
var command_message := ""
var pattern_events := 0
var boss_shots := 0
var shot_events: Dictionary = {}
var active_pattern := ""
var other_enemies: Dictionary = {}
var manual_bullet := false
var pending_bullets := 0
var staged_bullets := 0
var bullet_index := 0
var bullet_requests: Array = []
var native_shot_totals := {
	"manual": {"fired": 0, "hits": 0, "expired": 0, "cleared": 0, "blocked": 0},
	"boss": {"fired": 0, "hits": 0, "expired": 0, "cleared": 0, "blocked": 0},
	"other": {"fired": 0, "hits": 0, "expired": 0, "cleared": 0, "blocked": 0}
}
var clear_index := -1
var first_fill := true
var pending_nova := 0
var nova: Dictionary = {}
var refill_peak_us := 0

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_physics_priority = 1000002
	bridge = JavaScriptBridge.get_interface("VSReview")
	mode = str(bridge.mode)
	target_count = clampi(int(bridge.count), 0, CAPACITY)
	scenario_seed = int(bridge.seed)
	optimized = mode == "optimized"
	mixed = str(bridge.preset) == "mixed"
	cohort = JavaScriptBridge.get_interface("VSCrowd")
	# The native comparison only consumes seeded placement rows. It does not
	# need a second copy of the packed crowd or its rendering buffers.
	cohort.reset(CAPACITY if optimized else 1, scenario_seed)
	cohort.configureRoster(JSON.stringify(Data.ENEMIES), mixed)
	bulk_keys = JSON.parse_string(str(cohort.bulkKeys()))
	for id in Data.ENEMIES:
		catalog.append({"id": id, "name": Data.ENEMIES[id].name, "move": Data.ENEMIES[id].move})
	if optimized:
		cohort.warmCombat()
	seed(scenario_seed)
	# Every visit starts with the same equipment and no account progress.
	Save.data = Save.default_data()
	Save.data["low_gfx"] = false
	ViewSettings.apply_fit()
	ViewSettings.apply_gfx()
	# A slow renderer cannot accumulate many expensive simulation steps in a
	# single browser callback. Both modes have the same cap and report game time.
	Engine.max_physics_steps_per_frame = 2
	game = OptimizedGame.new() if optimized else OriginalGame.new()
	game.set_meta("main", self)
	game.setup({"char": "johagu", "map": "field", "auto": false})
	add_child(game)
	# Rasterize in the game's native pixel grid before scaling to the canvas.
	# The physics simulation and both sides of the A/B still run at 60 Hz.
	var window := get_window()
	window.content_scale_mode = Window.CONTENT_SCALE_MODE_VIEWPORT
	window.content_scale_size = Vector2i(640, 360)
	window.canvas_item_default_texture_filter = Viewport.DEFAULT_CANVAS_ITEM_TEXTURE_FILTER_NEAREST
	game.mob_mult = 0.0
	game.boss_index = Data.BOSS_TIMES.size()
	game.final_spawned = true
	game.process_mode = Node.PROCESS_MODE_DISABLED
	game.visible = false
	if optimized:
		preload("res://review/first_use.gd").warm(BOSS_TYPES)
		game.configure_crowd(CAPACITY)
	finisher = WaveFinisher.new()
	finisher.setup(self, game, cohort, optimized)
	game.finish_tracker = finisher
	_watch_native_world()
	if mixed:
		_install_roster()
		initializing_mix = true
		shot_floor = 10000
		_ensure_bosses()
	last_health = game.player.hp
	_report()

func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec() / 1000.0
	if now >= next_input:
		next_input = now + 0.045
		_read_commands()
	if phase == "clearing":
		_clear_some()
	if phase == "spawning":
		_fill_population(true)
		if _population() >= target_count:
			if first_fill:
				seed(scenario_seed)
				first_fill = false
			phase = "playing"
			game.visible = true
			game.process_mode = Node.PROCESS_MODE_PAUSABLE
			if initializing_mix:
				initializing_mix = false
				_force_all_patterns()
				_maintain_floor(false)
			_report()
	if pending_nova > 0 and phase == "playing":
		var requested := pending_nova
		pending_nova = 0
		_cast_nova(requested)
	if pending_finish > 0 and phase == "playing":
		var finish_id := pending_finish
		pending_finish = 0
		_finish_wave(finish_id)
	if pending_bullets > 0:
		_emit_projectiles()
	if now >= next_report:
		next_report = now + TELEMETRY_INTERVAL
		_report()

func _physics_process(delta: float) -> void:
	if phase != "playing" or get_tree().paused or game.finished:
		return
	if optimized:
		game.advance_crowd(delta)
	# Jjorang deaths from the aura happen before their movement phase. Count
	# survivors before adding replacements, which first move on the next tick.
	last_updated = int(cohort.updatedCount()) + _native_catalog_count() if optimized else _population()
	ticks += 1
	elapsed += delta
	var hp: float = game.player.hp
	if hp < last_health:
		hits_taken += 1
		damage_taken += last_health - hp
	# Keep the continuous play comparison alive; the original damage, hit
	# cooldown, audio and hit feedback have already run before this assistance.
	if hp > 0.0 and hp <= game.player.max_hp * (0.45 if mixed else 0.25):
		game.player.heal(game.player.max_hp)
		recoveries += 1
	# Resolve level rewards through the real game API. Both sides retain the
	# starter's aura and gain XP and levels without modal pauses during timing.
	while game.pending_levelups > 0:
		game.pending_levelups -= 1
		if game.player.weapons[0].level < 5:
			game.apply_option({"type": "weapon_up", "id": "menhera"})
		else:
			game.apply_option({"type": "gold"})
	last_health = game.player.hp
	if target_count > 0 and (mixed or _population() < target_count):
		_fill_population(false)
	_maintain_floor(true)
	finisher.tick()

func _fill_population(initial: bool) -> void:
	if mixed and target_count > 0:
		roster.ensure_groups(target_count)
	var missing := target_count - _population()
	if missing <= 0:
		return
	var at: Vector2 = game.player.global_position
	if optimized:
		var fill_start := Time.get_ticks_usec()
		cohort.fillRoster(maxi(0, target_count - _native_catalog_count()), at.x, at.y, initial)
		if not initial:
			refill_peak_us = maxi(refill_peak_us, Time.get_ticks_usec() - fill_start)
		return
	var deadline := Time.get_ticks_usec() + 6000
	while missing > 0:
		var count := mini(missing, 96)
		var data = cohort.spawnRosterRows(count, at.x, at.y, initial)
		var rows := JavaScriptBridge.js_buffer_to_packed_byte_array(data).to_float32_array()
		for index in range(0, rows.size(), 6):
			var id: String = bulk_keys[int(rows[index + 5])]
			var minion: bool = mixed and id in ["cookie_s", "alien_s", "bookworm_s", "mimic_s"]
			var enemy = game.spawn_enemy(id, Vector2(rows[index], rows[index + 1]), {"minion": minion} if minion else {})
			enemy.speed = rows[index + 3]
			enemy.phase = rows[index + 4]
		missing -= count
		if initial and Time.get_ticks_usec() >= deadline:
			return

func _population() -> int:
	return (int(cohort.aliveCount()) if optimized else 0) + _native_catalog_count()

func _native_catalog_count() -> int:
	return game.enemies.size() - _other_count()

func _other_count() -> int:
	if other_enemies.is_empty():
		return 0
	for actor_id in other_enemies.keys():
		var actor = other_enemies[actor_id]
		if not is_instance_valid(actor) or actor.dead:
			other_enemies.erase(actor_id)
	return other_enemies.size()

func _read_commands() -> void:
	var serialized := str(bridge.takeCommands())
	if serialized == "[]" or serialized.is_empty():
		return
	var commands = JSON.parse_string(serialized)
	if not commands is Array:
		return
	for request in commands:
		if not request is Dictionary:
			continue
		var id := int(request.get("id", 0))
		if id <= command_id:
			continue
		command_id = id
		if request.action in ["fill", "allEnemies", "combinedPeak", "clear", "nova"]:
			finisher.cancel()
			pending_finish = 0
		match str(request.get("action", "")):
			"fill":
				hold_clear = false
				target_count = CAPACITY
				if _population() < target_count:
					phase = "spawning"
					game.process_mode = Node.PROCESS_MODE_DISABLED
					game.visible = false
				command_message = "일반 적 10만 마리 배치"
			"allEnemies", "combinedPeak":
				_select_mixed()
				if request.action == "combinedPeak":
					_ensure_bosses()
					_force_all_patterns()
					_set_floor(30000)
				command_message = "모든 몬스터 혼합 배치" if request.action == "allEnemies" else "혼합 적·보스 10종·적 탄막 3만"
			"bosses10":
				_ensure_bosses()
				command_message = "원작 보스 10종 동시 소환"
			"patterns10":
				_ensure_bosses()
				_force_all_patterns()
				command_message = "원작 보스 10종 패턴 발동"
			"sustainShots", "sustain10k", "sustain30k":
				_set_floor(30000 if request.action == "sustain30k" or int(request.get("count", 10000)) >= 30000 else 10000)
				command_message = "적 탄막 최소 %d개 유지" % shot_floor
			"stopSustain":
				_set_floor(0)
				command_message = "자동 탄막 보충 중지"
			"clear":
				pending_nova = 0
				hold_clear = true
				resume_fill_after_clear = false
				target_count = 0
				if optimized:
					cohort.clear()
					game.target_handles.clear()
				_start_native_clear()
				command_message = "일반 적 제거"
			"projectiles", "projectiles10k":
				_watch_native_world()
				var count := 10000 if request.action == "projectiles10k" else 500
				var center: Vector2 = game.player.global_position
				if optimized:
					game.manual_shots.add_wave(count, center, bullet_index)
				else:
					bullet_requests.append({"left": count, "index": bullet_index, "center": center, "staged": []})
					pending_bullets += count
				bullet_index += count
				command_message = "원작 적 탄환 %s개 발사 요청" % ("10,000" if count == 10000 else "500")
			"clearProjectiles":
				_set_floor(0)
				pending_bullets = 0
				staged_bullets = 0
				bullet_requests.clear()
				if optimized:
					game.manual_shots.clear_wave()
				for shot in game.projectiles:
					if is_instance_valid(shot):
						shot.set_meta("review_cleared", true)
						shot.set_physics_process(false)
						shot.hide()
						shot.queue_free()
				game.projectiles.clear()
				command_message = "탄환 제거"
			"boss", "pattern":
				var kind := str(request.get("kind", "daebuntang"))
				if kind in BOSS_TYPES:
					_trigger_boss(kind, request.action == "pattern")
			"nova":
				if phase == "spawning":
					pending_nova = id
					command_message = "적 배치가 끝나면 광역기를 발동합니다"
				elif phase == "playing":
					_cast_nova(id)
			"finishWave":
				if phase == "spawning":
					pending_finish = id
					command_message = "배치 후 현재 무리를 전투로 처치합니다"
				elif phase == "playing":
					_finish_wave(id)
	_report()

func _finish_wave(id: int) -> void:
	if finisher.status == "running":
		return
	target_count = 0
	hold_clear = false
	finisher.begin(id, _catalog_sample(true))
	command_message = "지정한 무리를 원작 무기로 반복 공격"

func _resume_arena() -> void:
	game.visible = true
	game.process_mode = Node.PROCESS_MODE_PAUSABLE
	phase = "playing"

func _install_roster() -> void:
	if roster != null:
		return
	roster = MixedRoster.new()
	roster.setup(game, self, scenario_seed)
	game.add_child(roster)
	game.mapx = roster

func _select_mixed() -> void:
	hold_clear = false
	target_count = CAPACITY
	if not mixed:
		mixed = true
		cohort.configureRoster(JSON.stringify(Data.ENEMIES), true)
		if optimized:
			cohort.clear()
			game.target_handles.clear()
		_install_roster()
		resume_fill_after_clear = true
		_start_native_clear()
		return
	if _population() < target_count:
		phase = "spawning"
		game.visible = false
		game.process_mode = Node.PROCESS_MODE_DISABLED

func _start_native_clear() -> void:
	phase = "clearing"
	clear_index = game.enemies.size() - 1
	game.process_mode = Node.PROCESS_MODE_DISABLED
	game.visible = false
	if clear_index < 0:
		_clear_some()

func _clear_some() -> void:
	var deadline := Time.get_ticks_usec() + 4500
	while clear_index >= 0:
		var enemy = game.enemies[clear_index]
		if not enemy.boss:
			game.enemies.remove_at(clear_index)
			enemy.dead = true
			enemy.set_physics_process(false)
			enemy.queue_free()
		clear_index -= 1
		if Time.get_ticks_usec() >= deadline:
			return
	last_updated = 0
	if roster != null:
		roster.geometry_dirty = true
		roster.tick(0.0)
	if resume_fill_after_clear:
		resume_fill_after_clear = false
		phase = "spawning"
	else:
		_resume_arena()

func _watch_native_world() -> void:
	if not game.world.child_entered_tree.is_connected(_native_child):
		game.world.child_entered_tree.connect(_native_child)
		game.world.child_exiting_tree.connect(_native_exiting)

func _native_child(node: Node) -> void:
	if node is NativeEnemy:
		if node.boss or not Data.ENEMIES.has(node.kind):
			other_enemies[node.get_instance_id()] = node
		if not node.boss and node.kind == "heart":
			heart_spawned += 1
		if not node.boss and Data.ENEMIES.has(node.kind):
			native_species_spawned[node.kind] = int(native_species_spawned.get(node.kind, 0)) + 1
			if node.elite:
				native_elite_spawned[node.troll] = int(native_elite_spawned.get(node.troll, 0)) + 1
			if finisher != null:
				finisher.native_spawned(node)
			if roster != null:
				roster.note_native(node)
		if is_instance_valid(casting_boss) and not node.boss:
			pattern_details[casting_boss.kind].summons += 1
			pattern_output += 1
			if hold_clear:
				suppressed_summons.append(node)
	elif node.get_script() == NativeProjectile:
		var source := "manual" if manual_bullet else ("boss" if is_instance_valid(casting_boss) else "other")
		node.set_meta("review_source", source)
		if source != "manual":
			native_shot_totals[source].fired += 1
		if source == "boss":
			node.set_meta("review_boss_kind", casting_boss.kind)
			pattern_details[casting_boss.kind].shots += 1
			pattern_output += 1
			boss_shots += 1
			var family := str(node.kind)
			shot_events[family] = int(shot_events.get(family, 0)) + 1

func _native_exiting(node: Node) -> void:
	if node is NativeEnemy:
		if finisher != null:
			finisher.native_departed(node)
		return
	if node.get_script() != NativeProjectile or not node.has_meta("review_source") or node.get_meta("review_staged", false):
		return
	var count: Dictionary = native_shot_totals[node.get_meta("review_source")]
	if node.get_meta("review_cleared", false):
		count.cleared += 1
	elif node.hit_list.has("p"):
		count.hits += 1
	elif node.life <= 0.0:
		count.expired += 1
	elif game.mapx != null and (game.blocks(node.global_position) or node.get_meta("review_source") == "manual"):
		count.blocked += 1

func _emit_projectiles() -> void:
	var deadline := Time.get_ticks_usec() + 1600
	var made := 0
	manual_bullet = true
	while pending_bullets > 0:
		var request: Dictionary = bullet_requests[0]
		var i: int = request.index
		# Rotate each group of 500 independently. At 10,000 one-click shots,
		# all admitted body trajectories are distinct in both implementations.
		var shot = _native_shot(request.center, i)
		# Native node construction may span several browser frames. Arm the
		# entire requested wave together so its hit timing and lifetime match
		# the packed launch even when a large group takes longer to allocate.
		shot.set_meta("review_staged", true)
		shot.set_physics_process(false)
		shot.hide()
		request.staged.append(shot)
		staged_bullets += 1
		request.index += 1
		request.left -= 1
		if request.left == 0:
			for projectile in request.staged:
				projectile.remove_meta("review_staged")
				projectile.show()
				projectile.set_physics_process(true)
			var admitted: int = request.staged.size()
			native_shot_totals.manual.fired += admitted
			staged_bullets -= admitted
			bullet_requests.pop_front()
		pending_bullets -= 1
		made += 1
		if made >= 192 and Time.get_ticks_usec() >= deadline:
			break
	manual_bullet = false

func _native_shot(center: Vector2, i: int):
	var turn := TAU * float(i % 100) / 100.0 + (i / 500) * 2.39996322972865
	var band := (i / 100) % 5
	var outward := Vector2.from_angle(turn + band * 0.075)
	var at := center + outward * (98.0 + 14.0 * band)
	return game.spawn_bullet(at, -outward.rotated(0.08 * (band - 2)) * (50.0 + 8.0 * band), 4.0)

func _set_floor(value: int) -> void:
	if shot_floor == value:
		return
	shot_floor = value
	floor_ticks = 0
	floor_min = -1
	if value > 0 and phase == "playing":
		_maintain_floor(false)

func _hostile_count() -> int:
	var total := int(game.manual_shots.api.audit()) if optimized else 0
	for projectile in game.projectiles:
		if projectile.hostile and not projectile.get_meta("review_staged", false):
			total += 1
	return total

func _maintain_floor(record_tick: bool) -> void:
	if shot_floor <= 0:
		return
	var current := _hostile_count()
	var missing := shot_floor - current
	if missing > 0:
		var center: Vector2 = game.player.global_position
		if optimized:
			game.manual_shots.add_wave(missing, center, bullet_index)
		else:
			manual_bullet = true
			for i in missing:
				_native_shot(center, bullet_index + i)
			manual_bullet = false
			native_shot_totals.manual.fired += missing
		bullet_index += missing
		current = _hostile_count()
	if record_tick:
		floor_ticks += 1
		floor_min = current if floor_min < 0 else mini(floor_min, current)

func obtain_boss(kind: String):
	_watch_native_world()
	for actor in other_enemies.values():
		if is_instance_valid(actor) and not actor.dead and actor.boss and actor.kind == kind:
			return actor
	var previous = game.active_boss
	game._spawn_boss(kind)
	var boss = game.active_boss
	if kind == "daebuntang":
		boss.hp = boss.max_hp * 0.65
	if mixed:
		var angle := TAU * BOSS_TYPES.find(kind) / BOSS_TYPES.size()
		boss.global_position = game.player.global_position + Vector2(cos(angle) * 176.0, sin(angle) * 103.0)
	if not game.boss_group.has(boss):
		game.boss_group.append(boss)
		game.boss_group_max += boss.max_hp
	# A visual/debug selection must not change the global primary used by
	# upstream damage rules. The normal group-death handler selects its heir.
	if is_instance_valid(previous) and not previous.dead:
		game.active_boss = previous
	return boss

func _ensure_bosses() -> void:
	obtain_boss("doebaebot")
	for kind in BOSS_TYPES:
		obtain_boss(kind)

func _force_all_patterns() -> void:
	for kind in BOSS_TYPES:
		_trigger_boss(kind, true)

func _trigger_boss(kind: String, force: bool) -> void:
	var boss = obtain_boss(kind)
	selected_boss = boss
	if force:
		if kind == "bat" and boss.b_state in ["circle", "dive", "ret"]:
			boss.b_t = 2.1
			return
		boss.b_state = "walk"
		boss.targetable = true
		boss.alpha = 1.0
		boss.b_t = 0.0
		match kind:
			"daebuntang":
				boss.hp = boss.max_hp * 0.65
				boss.b_t2 = 2.5
			"doebaebot":
				boss.b_t = 4.1
			"buffering":
				boss.b_t = 5.1
			"glitch":
				boss.b_t2 = 2.6
			"stairs":
				boss.b_t = 4.1
			"blizzard":
				boss.b_t = 2.3
			"macaron":
				boss.b_dir = Vector2(2, 0)
				boss.b_t2 = 0.2
				boss.b_t = 3.3
			"bookworm":
				boss.b_t = 3.1
			"bat":
				boss.b_t = 7.1
			"returnbox":
				boss.b_t = 1.7
				boss.b_t2 = 6.1
	command_message = str(Data.BOSSES[kind].name) + (" 패턴 발동" if force else " 소환")

func begin_native_pattern(actor) -> void:
	casting_boss = actor
	pattern_initial_state = actor.b_state
	pattern_initial_zones = game.zones.size()
	pattern_output = 0
	shot_events.clear()
	if not pattern_details.has(actor.kind):
		pattern_details[actor.kind] = {"shots": 0, "summons": 0, "zones": 0, "transitions": 0}

func end_native_pattern(actor) -> void:
	var zones: int = maxi(0, game.zones.size() - pattern_initial_zones)
	var changed: bool = actor.b_state != pattern_initial_state
	if changed or zones > 0 or pattern_output > 0:
		var kind: String = actor.kind
		pattern_events += 1
		native_events[kind] = int(native_events.get(kind, 0)) + 1
		pattern_details[kind].zones += zones
		if changed:
			pattern_details[kind].transitions += 1
		var descriptions := PackedStringArray([str(Data.BOSSES[kind].name), str(actor.b_state)])
		for family in shot_events:
			descriptions.append("%s %d발" % [family, shot_events[family]])
		if zones > 0:
			descriptions.append("장판 %d개" % zones)
		if shot_events.is_empty() and pattern_output > 0:
			descriptions.append("소환 %d마리" % pattern_output)
		active_pattern = " · ".join(descriptions)
	casting_boss = null
	if not suppressed_summons.is_empty():
		for summon in suppressed_summons:
			if is_instance_valid(summon) and not summon.dead:
				summon._vanish()
		suppressed_summons.clear()

func _catalog_sample(with_ids := false) -> Dictionary:
	var counts: Dictionary = JSON.parse_string(str(cohort.composition())) if optimized else {}
	var admitted: Dictionary = JSON.parse_string(str(cohort.spawnedComposition())) if optimized else {}
	var native_live: Dictionary = {}
	var elites: Dictionary = {}
	for id in Data.ENEMIES:
		counts[id] = int(counts.get(id, 0))
		admitted[id] = int(admitted.get(id, 0)) + int(native_species_spawned.get(id, 0))
	var rect := Rect2(game.player.global_position - HALF_VIEW, HALF_VIEW * 2.0)
	var visible_n := int(cohort.visibleCount(game.player.global_position.x, game.player.global_position.y, HALF_VIEW.x, HALF_VIEW.y)) if optimized and game.visible else 0
	var ids := PackedInt64Array()
	if with_ids:
		ids.resize(game.enemies.size())
	var index := 0
	var hearts := 0
	var protected_units: Dictionary = {}
	for actor in game.enemies:
		if not is_instance_valid(actor) or actor.dead or actor.boss:
			continue
		if actor.kind == "heart":
			hearts += 1
			continue
		if not counts.has(actor.kind):
			continue
		counts[actor.kind] += 1
		native_live[actor.kind] = int(native_live.get(actor.kind, 0)) + 1
		if actor.elite:
			elites[actor.troll] = int(elites.get(actor.troll, 0)) + 1
		if game.visible and rect.has_point(actor.global_position):
			visible_n += 1
		if with_ids:
			ids[index] = actor.get_instance_id()
			var reason := ""
			if not actor.targetable:
				reason = "untargetable"
			elif actor.move == "wall":
				reason = "wallDamageCap"
			elif actor.elite:
				reason = "eliteHP"
			elif actor.move == "curl" and fmod(actor.b_t, 4.0) > 2.5:
				reason = "curlArmor"
			if reason != "":
				protected_units[reason] = int(protected_units.get(reason, 0)) + 1
		index += 1
	var living := 0
	var spawned_total := 0
	var present := 0
	for id in counts:
		living += int(counts[id])
		spawned_total += int(admitted[id])
		if counts[id] > 0:
			present += 1
	var signature := ""
	if with_ids:
		ids.resize(index)
		var packed_hash := str(cohort.auditSignature()) if optimized and int(cohort.aliveCount()) > 0 else ""
		var native_hash := "%08x" % (hash(ids) & 0xffffffff) if index > 0 else ""
		signature = packed_hash + ("-" if packed_hash != "" and native_hash != "" else "") + native_hash
		if signature.is_empty():
			signature = "00000000"
	return {"count": living, "species": counts, "admitted": admitted, "spawned": spawned_total,
		"present": present, "visible": visible_n, "hearts": hearts, "native": native_live,
		"ids": signature, "protected": protected_units, "elites": elites}

func deal_full_field() -> void:
	game.count_full_cast = true
	if not game.enemies.is_empty():
		game._rebuild_grid()
	game.player.weapons[0].cast_full_field(768.0, 64.0)
	game.count_full_cast = false

func _cast_nova(requested_id: int) -> void:
	var initial := _catalog_sample(true)
	target_count = 0
	hold_clear = false
	var prior_hits: int = game.full_hits + (game.pulse_targets if optimized else 0)
	var prior_deaths: int = game.full_ordinary_kills + (game.pulse_kills if optimized else 0)
	var prior_damage: float = game.full_ordinary_damage + (game.pulse_effective_damage if optimized else 0.0)
	var prior_xp: float = game.full_xp_created + (game.xp_dropped if optimized else 0)
	var prior_kills: int = game.kills
	var prior_weapon: float = game.dmg_stats.get("menhera", 0.0)
	game.full_native_hits_by_kind.clear()
	game.full_native_deaths_by_kind.clear()
	var start := Time.get_ticks_usec()
	deal_full_field()
	var duration := (Time.get_ticks_usec() - start) / 1000.0
	var final_sample := _catalog_sample(true)
	var survivors := {}
	for id in final_sample.species:
		if final_sample.species[id] > 0:
			survivors[id] = int(final_sample.species[id])
	var hits: int = game.full_hits + (game.pulse_targets if optimized else 0) - prior_hits
	var killed: int = game.full_ordinary_kills + (game.pulse_kills if optimized else 0) - prior_deaths
	var hp_loss: float = game.full_ordinary_damage + (game.pulse_effective_damage if optimized else 0.0) - prior_damage
	var xp_value: float = game.full_xp_created + (game.xp_dropped if optimized else 0) - prior_xp
	nova = {"id": requested_id, "before": initial["count"], "after": final_sample["count"],
		"liveIdsBefore": initial.ids, "liveIdsAfter": final_sample.ids, "hits": hits, "kills": killed,
		"gameKillDelta": game.kills - prior_kills, "commonDamage": hp_loss,
		"damage": game.dmg_stats.get("menhera", 0.0) - prior_weapon, "xpAwarded": xp_value,
		"ms": duration, "source": "menhera", "radius": 768, "minimumDamage": 64,
		"speciesBefore": initial.species, "speciesAfter": final_sample.species,
		"survivorsByKind": survivors, "survivorReasons": final_sample.protected,
		"nativeHitsByKind": game.full_native_hits_by_kind.duplicate(),
		"nativeKillsByKind": game.full_native_deaths_by_kind.duplicate()}
	command_message = "광역기 1회 · 일반 적 %d → %d" % [int(initial["count"]), int(final_sample["count"])]
	_report()

func _report() -> void:
	var position_in_world: Vector2 = game.player.global_position
	var audit := _catalog_sample()
	var alive := int(audit["count"])
	var visible_count := int(audit.visible)
	var boss_names: Array = []
	var boss_counts := {}
	var states := {}
	for actor in other_enemies.values():
		if is_instance_valid(actor) and not actor.dead and actor.boss:
			boss_names.append(actor.kind)
			boss_counts[actor.kind] = int(boss_counts.get(actor.kind, 0)) + 1
			states[actor.kind] = actor.b_state
	var boss_count := boss_names.size()
	var boss = selected_boss if is_instance_valid(selected_boss) and not selected_boss.dead else game.active_boss
	var native_shots := 0
	var debug_shots := 0
	var hostile_native := 0
	var player_shots := 0
	var other_hostile := 0
	for shot in game.projectiles:
		if shot.get_meta("review_staged", false):
			continue
		if not shot.hostile:
			player_shots += 1
			continue
		hostile_native += 1
		match str(shot.get_meta("review_source", "")):
			"boss": native_shots += 1
			"manual": debug_shots += 1
			_: other_hostile += 1
	var pooled_live := 0
	var fired: int = native_shot_totals.manual.fired
	var hits: int = native_shot_totals.manual.hits
	var expired: int = native_shot_totals.manual.expired
	var cleared: int = native_shot_totals.manual.cleared
	var blocked: int = native_shot_totals.manual.blocked
	if optimized:
		var pooled = game.manual_shots.api
		pooled_live = int(pooled.audit())
		fired += int(pooled.fired("manual"))
		hits += int(pooled.hits("manual"))
		expired += int(pooled.expired("manual"))
		cleared += int(pooled.cleared("manual"))
		blocked += int(pooled.blocked("manual"))
	var data := {
		"mode": mode, "phase": "paused" if get_tree().paused else phase,
		"ready": phase == "playing" and ticks > 0 and not get_tree().paused,
		"target": target_count, "alive": alive, "visible": visible_count,
		"submittedBodies": (int(cohort.renderedCount()) if game.visible else 0) if optimized else -1,
		"updated": last_updated, "spawned": audit.spawned, "kills": game.kills,
		"damage": game.dmg_stats.get("menhera", 0.0), "hp": game.player.hp,
		"hitsTaken": hits_taken, "damageTaken": damage_taken, "recoveries": recoveries,
		"maxHp": game.player.max_hp, "xp": game.xp, "level": game.level,
		"weaponLevel": game.player.weapons[0].level,
		"x": position_in_world.x, "y": position_in_world.y, "simTime": elapsed, "ticks": ticks,
		"draws": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		"engineFps": Engine.get_frames_per_second(),
		"renderWidth": get_window().content_scale_size.x, "renderHeight": get_window().content_scale_size.y,
		"physicsHz": Engine.physics_ticks_per_second,
		"maxPhysicsSteps": Engine.max_physics_steps_per_frame,
		"nodes": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"bosses": boss_count, "bossKind": str(boss.kind) if is_instance_valid(boss) and not boss.dead else "",
		"bossState": str(boss.b_state) if is_instance_valid(boss) and not boss.dead else "",
		"primaryBossKind": str(game.active_boss.kind) if is_instance_valid(game.active_boss) and not game.active_boss.dead else "",
		"mixed": mixed, "speciesCatalog": catalog, "speciesPresent": audit.present, "speciesAlive": audit.species,
		"speciesSpawned": audit.admitted, "nativeSpeciesAlive": audit.native, "heartAlive": audit.hearts,
		"nativeEliteCounts": audit.elites, "nativeEliteSpawned": native_elite_spawned,
		"heartSpawned": heart_spawned, "heartContacts": game.heart_contacts,
		"entityTotal": alive + boss_count + int(audit.hearts), "bossKindsAlive": boss_names, "bossCounts": boss_counts,
		"bossPatternStates": states, "bossPatternEvents": native_events, "bossPatternDetails": pattern_details,
		"shotFloor": shot_floor, "shotFloorMinTick": floor_min, "shotFloorTicks": floor_ticks,
		"hostileProjectiles": hostile_native + pooled_live, "playerProjectiles": player_shots,
		"otherNativeHostileProjectiles": other_hostile, "manualShotBlocked": blocked,
		"lastPattern": active_pattern, "patternEvents": pattern_events, "bossPatterns": pattern_events,
		"projectiles": game.projectiles.size() - staged_bullets + pooled_live, "bossProjectiles": native_shots,
		"manualProjectiles": debug_shots + pooled_live, "pooledProjectiles": pooled_live,
		"manualSubmitted": int(game.manual_shots.api.layerCount("hate")) if optimized else null,
		"manualHiddenCopies": int(game.manual_shots.api.pixelCullCount) if optimized else null,
		"nativeProjectiles": game.projectiles.size() - staged_bullets, "manualShotsFired": fired, "manualShotHits": hits,
		"manualShotExpired": expired, "manualShotCleared": cleared,
		"manualShotHpDamage": game.manual_shots.hp_lost_to_wave if optimized else null,
		"shotSlowRemaining": game.player.slow_t, "shotSlowFactor": game.player.slow_mult,
		"bossShotHits": native_shot_totals.boss.hits, "bossShotExpired": native_shot_totals.boss.expired,
		"bossShotCleared": native_shot_totals.boss.cleared,
		"bossShotsFired": boss_shots, "projectilesPending": pending_bullets + staged_bullets, "zones": game.zones.size(),
		"nativeEffects": game.fx.items.size(),
		"xpQueued": game.queued_xp if optimized else 0, "dropBinsPending": game.pending_bin_count if optimized else 0,
		"commandId": command_id, "commandMessage": command_message, "nova": nova, "finishWave": finisher.snapshot()
	}
	if optimized:
		if game.manual_shots.has_method("wall_spark_stats"):
			data["wallSparks"] = game.manual_shots.wall_spark_stats()
		data["peakMsSinceSample"] = {
			"motion": game.motion_peak_us / 1000.0,
			"rewardNodes": game.reward_peak_us / 1000.0,
			"areaHit": game.area_peak_us / 1000.0,
			"replacement": refill_peak_us / 1000.0,
			"straightShots": game.manual_shots.peak_step_us / 1000.0
		}
		game.motion_peak_us = 0
		game.reward_peak_us = 0
		game.area_peak_us = 0
		game.manual_shots.peak_step_us = 0
		refill_peak_us = 0
	bridge.sample(JSON.stringify(data))

func goto(_screen: String, _params := {}) -> void:
	phase = "ended"
	game.process_mode = Node.PROCESS_MODE_DISABLED
	get_tree().paused = false
	_report()
