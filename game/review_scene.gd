extends Node

const OriginalGame = preload("res://review/stock_debug_game.gd")
const OptimizedGame = preload("res://review/optimized_game.gd")
const ViewSettings = preload("res://scripts/ui/ui_util.gd")
const NativeProjectile = preload("res://scripts/game/projectile.gd")
const NativeEnemy = preload("res://scripts/game/enemy.gd")
const HALF_VIEW := Vector2(320, 180)
const TELEMETRY_INTERVAL := 0.25
const CAPACITY := 100000
const BOSS_TYPES := ["daebuntang", "doebaebot", "buffering", "glitch"]

var bridge
var game
var optimized := false
var mode := "original"
var target_count := CAPACITY
var scenario_seed := 7
var cohort
var enemy_kind: Dictionary
var phase := "spawning"
var spawned := 0
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
var zone_event_index := 0
var prior_state := ""
var active_pattern := ""
var other_enemies: Dictionary = {}
var manual_bullet := false
var pending_bullets := 0
var staged_bullets := 0
var bullet_index := 0
var bullet_requests: Array = []
var native_shot_totals := {
	"manual": {"fired": 0, "hits": 0, "expired": 0, "cleared": 0},
	"boss": {"fired": 0, "hits": 0, "expired": 0, "cleared": 0}
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
	cohort = JavaScriptBridge.get_interface("VSCrowd")
	# The native comparison only consumes seeded placement rows. It does not
	# need a second copy of the packed crowd or its rendering buffers.
	cohort.reset(CAPACITY if optimized else 1, scenario_seed)
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
	enemy_kind = Data.ENEMIES["jjorang"]
	if optimized:
		preload("res://review/first_use.gd").warm(BOSS_TYPES)
		game.configure_crowd(CAPACITY)
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
			_report()
	if pending_nova > 0 and phase == "playing":
		var requested := pending_nova
		pending_nova = 0
		_cast_nova(requested)
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
	last_updated = int(cohort.updatedCount()) if optimized else _population()
	ticks += 1
	elapsed += delta
	var hp: float = game.player.hp
	if hp < last_health:
		hits_taken += 1
		damage_taken += last_health - hp
	# Keep the continuous play comparison alive; the original damage, hit
	# cooldown, audio and hit feedback have already run before this assistance.
	if hp > 0.0 and hp <= game.player.max_hp * 0.25:
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
	if target_count > 0 and _population() < target_count:
		_fill_population(false)
	_observe_pattern()

func _fill_population(initial: bool) -> void:
	var missing := target_count - _population()
	if missing <= 0:
		return
	var at: Vector2 = game.player.global_position
	if optimized:
		var fill_start := Time.get_ticks_usec()
		cohort.fill(target_count, at.x, at.y, initial, float(enemy_kind.hp), float(enemy_kind.speed))
		if not initial:
			refill_peak_us = maxi(refill_peak_us, Time.get_ticks_usec() - fill_start)
		spawned += missing
		return
	var deadline := Time.get_ticks_usec() + 6000
	while missing > 0:
		var count := mini(missing, 96)
		var data = cohort.spawnRows(count, at.x, at.y, initial, float(enemy_kind.hp), float(enemy_kind.speed))
		var rows := JavaScriptBridge.js_buffer_to_packed_byte_array(data).to_float32_array()
		for index in range(0, rows.size(), 5):
			var enemy = game.spawn_enemy("jjorang", Vector2(rows[index], rows[index + 1]))
			enemy.speed = rows[index + 3]
			enemy.phase = rows[index + 4]
		missing -= count
		spawned += count
		if initial and Time.get_ticks_usec() >= deadline:
			return

func _population() -> int:
	if optimized:
		return int(cohort.aliveCount())
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
		match str(request.get("action", "")):
			"fill":
				target_count = CAPACITY
				if _population() < target_count:
					phase = "spawning"
					game.process_mode = Node.PROCESS_MODE_DISABLED
					game.visible = false
				command_message = "일반 적 10만 마리 배치"
			"clear":
				pending_nova = 0
				target_count = 0
				if optimized:
					cohort.clear()
					game.target_handles.clear()
					last_updated = 0
					_resume_arena()
				else:
					phase = "clearing"
					clear_index = game.enemies.size() - 1
					game.process_mode = Node.PROCESS_MODE_DISABLED
					game.visible = false
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
	_report()

func _resume_arena() -> void:
	game.visible = true
	game.process_mode = Node.PROCESS_MODE_PAUSABLE
	phase = "playing"

func _clear_some() -> void:
	var deadline := Time.get_ticks_usec() + 4500
	while clear_index >= 0:
		var enemy = game.enemies[clear_index]
		if not enemy.boss and enemy.kind == "jjorang" and not enemy.minion:
			game.enemies.remove_at(clear_index)
			enemy.dead = true
			enemy.set_physics_process(false)
			enemy.queue_free()
		clear_index -= 1
		if Time.get_ticks_usec() >= deadline:
			return
	last_updated = 0
	_resume_arena()

func _watch_native_world() -> void:
	if not game.world.child_entered_tree.is_connected(_native_child):
		game.world.child_entered_tree.connect(_native_child)
		game.world.child_exiting_tree.connect(_native_exiting)

func _native_child(node: Node) -> void:
	if node.get_script() == NativeEnemy and (node.boss or node.minion or node.kind != "jjorang"):
		other_enemies[node.get_instance_id()] = node
	elif node.get_script() == NativeProjectile:
		var source := "manual" if manual_bullet else "boss"
		node.set_meta("review_source", source)
		if not manual_bullet:
			native_shot_totals.boss.fired += 1
			boss_shots += 1
			var family := str(node.kind)
			shot_events[family] = int(shot_events.get(family, 0)) + 1

func _native_exiting(node: Node) -> void:
	if node.get_script() != NativeProjectile or not node.has_meta("review_source") or node.get_meta("review_staged", false):
		return
	var count: Dictionary = native_shot_totals[node.get_meta("review_source")]
	if node.get_meta("review_cleared", false):
		count.cleared += 1
	elif node.hit_list.has("p"):
		count.hits += 1
	elif node.life <= 0.0:
		count.expired += 1

func _emit_projectiles() -> void:
	var deadline := Time.get_ticks_usec() + 1600
	var made := 0
	manual_bullet = true
	while pending_bullets > 0:
		var request: Dictionary = bullet_requests[0]
		var i: int = request.index
		# Rotate each group of 500 independently. At 10,000 one-click shots,
		# all admitted body trajectories are distinct in both implementations.
		var turn := TAU * float(i % 100) / 100.0 + (i / 500) * 2.39996322972865
		var band := (i / 100) % 5
		var outward := Vector2.from_angle(turn + band * 0.075)
		var at: Vector2 = request.center + outward * (98.0 + 14.0 * band)
		var shot = game.spawn_bullet(at, -outward.rotated(0.08 * (band - 2)) * (50.0 + 8.0 * band), 4.0)
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

func _trigger_boss(kind: String, force: bool) -> void:
	_watch_native_world()
	var boss
	for actor in other_enemies.values():
		if is_instance_valid(actor) and not actor.dead and actor.boss and actor.kind == kind:
			boss = actor
			break
	if boss == null:
		game._spawn_boss(kind)
		boss = game.active_boss
		# The final boss's real 50–75% health phase fires its radial pattern.
		if kind == "daebuntang":
			boss.hp = boss.max_hp * 0.65
	else:
		game.active_boss = boss
	if force:
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
	command_message = str(Data.BOSSES[kind].name) + (" 패턴 발동" if force else " 소환")

func _observe_pattern() -> void:
	var boss = game.active_boss
	var state_label := ""
	if is_instance_valid(boss) and not boss.dead:
		state_label = str(boss.kind) + " / " + str(boss.b_state)
	var current_zone_count: int = game.zones.size()
	var new_zones := maxi(0, current_zone_count - zone_event_index)
	if not shot_events.is_empty() or new_zones > 0 or (not state_label.is_empty() and state_label != prior_state):
		pattern_events += 1
		var descriptions: PackedStringArray = []
		if not state_label.is_empty() and state_label != prior_state:
			descriptions.append(state_label)
		for family in shot_events:
			var title: String = {"hate": "대분탕 원형탄", "rev": "글리치 역전탄"}.get(family, family)
			descriptions.append("%s %d발" % [title, shot_events[family]])
		if new_zones > 0:
			var zone_kind := str(game.zones.back().get("kind", ""))
			var title: String = {"k": "도배봇 감속 장판", "load": "버퍼링 감속 장판"}.get(zone_kind, "장판")
			descriptions.append("%s %d개" % [title, new_zones])
		active_pattern = " · ".join(descriptions)
	prior_state = state_label
	shot_events.clear()
	zone_event_index = current_zone_count

func _population_snapshot() -> Dictionary:
	if optimized:
		return {"count": int(cohort.auditLiveCount()), "ids": str(cohort.auditSignature())}
	var ids := PackedInt64Array()
	ids.resize(game.enemies.size())
	var count := 0
	for actor in game.enemies:
		if actor.dead or actor.boss or actor.minion or actor.kind != "jjorang":
			continue
		ids[count] = actor.get_instance_id()
		count += 1
	ids.resize(count)
	return {"count": count, "ids": "%08x" % (hash(ids) & 0xffffffff) if count > 0 else "00000000"}

func _cast_nova(requested_id: int) -> void:
	# Original Jjorang relocation begins at 520 units. A true 768-unit damage
	# radius covers even respawned units while keeping a geometric range test.
	var initial_snapshot := _population_snapshot()
	var before := int(initial_snapshot["count"])
	target_count = 0
	var prior_hits: int = game.pulse_targets if optimized else game.full_hits
	var prior_ordinary_kills: int = game.pulse_kills if optimized else game.full_ordinary_kills
	var prior_ordinary_damage: float = game.pulse_effective_damage if optimized else game.full_ordinary_damage
	var prior_xp: float = game.xp_dropped if optimized else game.full_xp_created
	var prior_kills: int = game.kills
	var prior_damage: float = game.dmg_stats.get("menhera", 0.0)
	var start := Time.get_ticks_usec()
	if not optimized:
		game.count_full_cast = true
		game._rebuild_grid()
	game.player.weapons[0].cast_full_field(768.0, 64.0)
	if not optimized:
		game.count_full_cast = false
	var duration := (Time.get_ticks_usec() - start) / 1000.0
	var final_snapshot := _population_snapshot()
	var after := int(final_snapshot["count"])
	var hits: int = (game.pulse_targets if optimized else game.full_hits) - prior_hits
	var ordinary_kills: int = (game.pulse_kills if optimized else game.full_ordinary_kills) - prior_ordinary_kills
	var ordinary_damage: float = (game.pulse_effective_damage if optimized else game.full_ordinary_damage) - prior_ordinary_damage
	var reward: float = (game.xp_dropped if optimized else game.full_xp_created) - prior_xp
	nova = {
		"id": requested_id, "before": before, "after": after, "hits": hits,
		"liveIdsBefore": initial_snapshot.ids, "liveIdsAfter": final_snapshot.ids,
		"kills": ordinary_kills, "gameKillDelta": game.kills - prior_kills, "commonDamage": ordinary_damage,
		"damage": game.dmg_stats.get("menhera", 0.0) - prior_damage,
		"xpAwarded": reward, "ms": duration, "source": "menhera", "radius": 768, "minimumDamage": 64
	}
	command_message = "광역기 1회 · 일반 적 %d → %d" % [before, after]
	_report()

func _report() -> void:
	var position_in_world: Vector2 = game.player.global_position
	var alive := int(cohort.auditLiveCount()) if optimized else _population()
	var visible_count := 0
	if game.visible and optimized:
		visible_count = int(cohort.visibleCount(position_in_world.x, position_in_world.y, HALF_VIEW.x, HALF_VIEW.y))
	elif game.visible:
		var viewport_rect := Rect2(position_in_world - HALF_VIEW, HALF_VIEW * 2.0)
		for enemy in game.enemies:
			if not enemy.boss and not enemy.minion and enemy.kind == "jjorang" and viewport_rect.has_point(enemy.global_position):
				visible_count += 1
	var boss_count := 0
	for actor in other_enemies.values():
		if is_instance_valid(actor) and not actor.dead and actor.boss:
			boss_count += 1
	var boss = game.active_boss
	var native_shots := 0
	var debug_shots := 0
	for shot in game.projectiles:
		if shot.get_meta("review_staged", false):
			continue
		match str(shot.get_meta("review_source", "")):
			"boss": native_shots += 1
			"manual": debug_shots += 1
	var pooled_live := 0
	var fired: int = native_shot_totals.manual.fired
	var hits: int = native_shot_totals.manual.hits
	var expired: int = native_shot_totals.manual.expired
	var cleared: int = native_shot_totals.manual.cleared
	if optimized:
		var pooled = game.manual_shots.api
		pooled_live = int(pooled.audit())
		fired += int(pooled.fired("manual"))
		hits += int(pooled.hits("manual"))
		expired += int(pooled.expired("manual"))
		cleared += int(pooled.cleared("manual"))
	var data := {
		"mode": mode, "phase": "paused" if get_tree().paused else phase,
		"ready": phase == "playing" and ticks > 0 and not get_tree().paused,
		"target": target_count, "alive": alive, "visible": visible_count,
		"submittedBodies": (int(cohort.renderedCount()) if game.visible else 0) if optimized else -1,
		"updated": last_updated, "spawned": spawned, "kills": game.kills,
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
		"lastPattern": active_pattern, "patternEvents": pattern_events, "bossPatterns": pattern_events,
		"projectiles": game.projectiles.size() - staged_bullets + pooled_live, "bossProjectiles": native_shots,
		"manualProjectiles": debug_shots + pooled_live, "pooledProjectiles": pooled_live,
		"nativeProjectiles": game.projectiles.size() - staged_bullets, "manualShotsFired": fired, "manualShotHits": hits,
		"manualShotExpired": expired, "manualShotCleared": cleared,
		"manualShotHpDamage": game.manual_shots.hp_lost_to_wave if optimized else null,
		"shotSlowRemaining": game.player.slow_t, "shotSlowFactor": game.player.slow_mult,
		"bossShotHits": native_shot_totals.boss.hits, "bossShotExpired": native_shot_totals.boss.expired,
		"bossShotCleared": native_shot_totals.boss.cleared,
		"bossShotsFired": boss_shots, "projectilesPending": pending_bullets + staged_bullets, "zones": game.zones.size(),
		"xpQueued": game.queued_xp if optimized else 0, "dropBinsPending": game.pending_bin_count if optimized else 0,
		"commandId": command_id, "commandMessage": command_message, "nova": nova
	}
	if optimized:
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
