# 군중 최적화 인수인계

**[10만 디버그 전투](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=100k-r4&mode=optimized&count=100000&seed=7) · [일반 웨이브](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=100k-r4&scenario=normal&mode=optimized&seed=7)**

1. **배포** — [app.js](app.js)가 고정된 원작 웹 빌드를 해시로 확인하고, [pack.js](pack.js)가 브라우저 메모리에서 실험 씬을 추가한다. GitHub Pages는 이 저장소의 `main` 루트를 서비스한다.
2. **10만 개체** — [swarm.js](game/swarm.js)는 적별 좌표·체력·속도·상태를 두고 매 물리 틱 이동한다. 공격 후보는 공간 격자에서 찾고 생존 수는 생사 플래그로 센다. [렌더 워커](game/crowd_worker.js)는 640×360 도트 화면에서 가려진 픽셀을 검사한다. [crowd_renderer.gd](game/crowd_renderer.gd)가 남은 몸통·그림자를 MultiMesh로 그린다. UI의 화면 안 생존 수, 제출한 몸통 수, Godot 노드 수는 서로 다른 지표다.
3. **광역기** — [stress_aura.gd](game/stress_aura.gd)는 조하구 원작 무기에 시험 반경 768·최소 피해 64를 한 번 적용한다. [optimized_game.gd](game/optimized_game.gd)가 개별 HP와 사망을 처리하고 가까운 드롭을 묶어 물리 아이템으로 만든다. 디버그 삭제는 보상을 발생시키지 않는다.
4. **보스·탄환·일반 플레이** — [review_scene.gd](game/review_scene.gd)의 버튼은 원작 보스 상태 기계와 실제 투사체를 호출한다. [normal_scene.gd](game/normal_scene.gd)에서 일반 소환·레벨업·5분 보스를 확인할 수 있다. 대규모 군중 경로는 공원 일반 쪼랭이에서 검증한다.
5. **재검증** — `python qa/debug_controls.py`가 10만 적중·사망·경험치와 공격 프레임을 확인한다. `python qa/play.py --case combined --boss-kind all`은 군중·탄막·보스를, `--case normal`은 혼합 웨이브를 측정한다. 브라우저 FPS와 함께 실제 군중 표시 Hz, P99·최장 프레임, 게임 시계 진행률을 본다. [테스트 코드](qa/)
