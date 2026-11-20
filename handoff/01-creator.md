# 원작자님께 드리는 웹 전투 최적화 요약

**먼저 볼 곳은 탄이 벽에 맞을 때의 불꽃입니다.** 탄 한 발마다 불꽃 세 개가 생깁니다. 각각의 꼬리와 몸통, 중심을 따로 그리다 보니 탄이 몰릴 때 화면이 끊겼습니다.

실험판은 같은 수의 불꽃을 묶어 그립니다. 완전히 포개진 적탄이나 다른 몹에 전부 가려진 몸통도 그림만 생략합니다. 이동과 충돌은 계속 계산합니다.

몹 10만·보스 10종·적탄 3만의 같은 12초 동안 **벽 불꽃 처리만 바꾸자 평균 14.2 → 64.7 FPS**가 나왔습니다. GitHub Pages 데스크톱 실측이며, 순간 끊김은 남았습니다. [기기와 측정표](https://github.com/lorelona08-dotcom/vtuber-survival-crowd-study/blob/5fcad40b246609108e9a5141c38f92c1ebfe95e7/README.md#공개-웹에서-직접-측정한-결과)

**원작에는 화면 표시만 제안드립니다.** 소환·피해·경험치는 원래 코드가 결정합니다. 10만 강제 소환과 경험치 합산은 실험 전용입니다.

[직접 플레이하고 ‘3만 유지’ 누르기](https://lorelona08-dotcom.github.io/vtuber-survival-crowd-study/?v=mixed-r7&preset=mixed&mode=optimized&count=100000&seed=7) · [에이전트에게 건넬 텍스트](02-agent.txt) · [코드 위치와 병목 상세](03-code-review.md)
