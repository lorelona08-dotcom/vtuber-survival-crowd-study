extends Node2D

const CookieTerrain = preload("res://scripts/game/cookie_map.gd")
const JunkTerrain = preload("res://scripts/game/junk_map.gd")
const SPECIAL := ["bat_s", "kyupok", "deukdeoji", "kongchi", "ggultteok", "chunsik", "ttakkeumi", "junk_pile", "cookie_wall"]

var game
var observer
var crowd
var shots
var cookie
var junk
var rng := RandomNumberGenerator.new()
var groups: Dictionary = {}
const ELITES := {"ttakkeumi": ["flirt", "multi"], "ggultteok": ["hate"], "chunsik": ["spam"], "deukdeoji": ["backseat"]}
var elite_actors := {}
var serial := 0
var geometry_dirty := true
var last_count := -1
var quotas: Dictionary = {}

func setup(owner_game, owner_review, seed_value: int) -> void:
	game = owner_game
	observer = owner_review
	rng.seed = seed_value + 1907
	crowd = JavaScriptBridge.get_interface("VSCrowd")
	shots = JavaScriptBridge.get_interface("VSProjectiles")
	cookie = CookieTerrain.new()
	junk = JunkTerrain.new()
	cookie.game = game
	junk.game = game
	for id in SPECIAL:
		groups[id] = []

func note_native(actor) -> void:
	if not actor.boss and groups.has(actor.kind):
		groups[actor.kind].append(actor)
		if actor.move == "wall":
			geometry_dirty = true

func _position() -> Vector2:
	var angle := rng.randf() * TAU
	var range_scale := rng.randf_range(0.50, 0.90)
	return game.player.global_position + Vector2(cos(angle) * 220.0, sin(angle) * 115.0) * range_scale

func _live(id: String) -> int:
	var members: Array = groups[id]
	for i in range(members.size() - 1, -1, -1):
		if not is_instance_valid(members[i]) or members[i].dead:
			members.remove_at(i)
	return members.size()

func _configure_count(target: int) -> void:
	if last_count == target:
		return
	last_count = target
	var k := clampf(sqrt(target / 100000.0), 0.0, 1.0)
	quotas = {
		"bat_s": 10, "kyupok": 5 * maxi(1, roundi(6.0 * k)), "kongchi": 6 * maxi(1, roundi(4.0 * k)),
		"deukdeoji": maxi(3, roundi(20 * k)), "ggultteok": maxi(3, roundi(20 * k)),
		"chunsik": maxi(3, roundi(20 * k)), "ttakkeumi": maxi(4, roundi(20 * k)),
		"junk_pile": maxi(2, roundi(6 * k)), "cookie_wall": maxi(2, roundi(8 * k))
	}

func ensure_groups(target: int) -> void:
	if target <= 0:
		return
	_configure_count(target)
	for id in SPECIAL:
		var living := _live(id)
		var missing := int(quotas[id]) - living
		if missing <= 0:
			continue
		match id:
			"bat_s":
				# The real boss's own swarm code supplies owner_boss, angular
				# offset and the circle/dive/return state of every bat.
				if living == 0:
					var bat = observer.obtain_boss("bat")
					if is_instance_valid(bat):
						bat.b_state = "walk"
						bat.targetable = true
						bat.alpha = 1.0
						bat.b_t = 7.1
						bat._physics_process(0.0)
			"kyupok", "kongchi":
				var count := 5 if id == "kyupok" else 6
				while missing >= count:
					_formation(id, count)
					missing -= count
			"junk_pile", "cookie_wall":
				for i in missing:
					var pos := _position()
					if id == "junk_pile":
						junk._add_pile(pos)
					else:
						serial += 1
						var key := "review_%d" % serial
						cookie.live[key] = cookie._spawn_wall(key, pos)
					geometry_dirty = true
			_:
				for i in missing:
					var affix := ""
					for candidate in ELITES.get(id, []):
						var previous = elite_actors.get(candidate)
						if not is_instance_valid(previous) or previous.dead:
							affix = candidate
							break
					var options: Dictionary = {"troll": affix, "elite": true} if not affix.is_empty() else {}
					var actor = game.spawn_enemy(id, _position(), options)
					if not affix.is_empty():
						elite_actors[affix] = actor
					if affix == "flirt":
						actor.troll_t = 2.7
						actor._troll_tick(0.0, 90.0)
					elif affix == "hate":
						actor.troll_t = 2.25
	if geometry_dirty:
		_sync_geometry()

func _formation(id: String, count: int) -> void:
	var start := _position()
	var forward: Vector2 = (game.player.global_position - start).normalized()
	var side := Vector2(-forward.y, forward.x)
	var leader = null
	for i in count:
		if id == "kyupok":
			leader = game.spawn_enemy(id, start - forward * (13.0 * i), {"follow": leader})
		else:
			var pos := start + side * ((i - 2.5) * 12.0) - forward * ((i % 2) * 8.0)
			var fish = game.spawn_enemy(id, pos)
			fish.b_dir = forward

func _sync_geometry() -> void:
	geometry_dirty = false
	for key in cookie.live.keys():
		var actor = cookie.live[key]
		if not is_instance_valid(actor) or actor.dead:
			cookie.live.erase(key)
	for i in range(junk.piles.size() - 1, -1, -1):
		if not is_instance_valid(junk.piles[i]) or junk.piles[i].dead:
			junk.piles.remove_at(i)
	cookie._rects_cache = cookie._live_rects()
	junk._rects.clear()
	for actor in junk.piles:
		junk._rects.append(junk._pile_rect(actor.global_position))
	var geometry: Array = []
	for rectangles in [cookie._rects_cache, junk._rects]:
		for rect in rectangles:
			geometry.append([rect.position.x, rect.position.y, rect.size.x, rect.size.y])
	var serialized := JSON.stringify(geometry, "", true, true)
	crowd.setWalls(serialized)
	shots.setWalls(serialized)

func tick(_delta: float) -> void:
	if geometry_dirty:
		_sync_geometry()

func wall_count() -> int:
	return cookie._rects_cache.size() + junk._rects.size()

func blocks(point: Vector2) -> bool:
	return cookie.blocks(point) or junk.blocks(point)

func push_out(point: Vector2, radius: float) -> Vector2:
	return junk.push_out(cookie.push_out(point, radius), radius)

func wall_broken(actor) -> void:
	if actor.kind == "cookie_wall":
		cookie.wall_broken(actor)
	elif actor.kind == "junk_pile":
		junk.wall_broken(actor)
	geometry_dirty = true

func _exit_tree() -> void:
	if is_instance_valid(cookie):
		cookie.free()
	if is_instance_valid(junk):
		junk.free()
