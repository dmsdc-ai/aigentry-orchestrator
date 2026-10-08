# Task 1174 — Meshy → Roblox / agent integration
Operation: mr1174-v1; researcher: mr1174-researcher.
Public HTTPS access window: 2026-09-13 11:19–11:21 UTC (20:19–20:21 KST).
Method: fetched official public HTML/Markdown with curl; web tool connection failed. Documentation observations only, no performed integration.

## Compatibility findings
- Meshy exports include FBX, GLB, OBJ, USDZ; its format guide additionally describes BLEND, STL, 3MF and DXF. Availability depends on feature/output; API docs explicitly warn that not every format is produced for every task. [S2, S3]
- Simplest documented overlap: export an original static prop as FBX, then Roblox Studio File → Import, inspect preview/settings and warnings, and import. Roblox documents FBX, glTF and OBJ; FBX/glTF can carry textures, rigs and animation. [S2, S4]
- Do not conflate manual importer extensions with Bridge transport: Meshy's Bridge specifically uploads GLB. [S5, S6]
- An official Meshy Roblox Bridge is documented and offered publicly: standalone desktop app for macOS/Windows, Pro or higher, Roblox account and OAuth authorization. The page calls it a plugin in navigation, but describes its architecture as a desktop app. Download/install/live availability were not tested. [S5, S6]
- Bridge transfers workspace and community models to Roblox inventory; Studio can find them through Toolbox → Inventory → My Packages. This transfer capability does not establish rights to a particular model. [S6]
- Static props still need remeshing/optimization and validation of scale, orientation, textures, collision and appearance/performance in the target experience. Import success is not production readiness. [S4, S6; practical recommendation]
- Animated NPCs require compatible skeleton, skinning and animation setup; a Meshy rig is not evidence of automatic Roblox compatibility. Importer distinguishes Custom, R15 and No Rig. [S4]
- Platform avatar bodies have additional Roblox requirements for body parts/names, rig hierarchy, skinning, attachments, textures and cages; Marketplace validation is a separate requirement. A decorative cat, custom NPC and platform avatar are different targets. [S7]
- Generating/importing a model does not create playable game logic, controls or an experience; those remain a separate implementation phase.

## License and download scope
- Own generated assets, paid plan: help states private ownership and commercial use without Meshy attribution, conditional on lawful source materials and not publishing the asset to Community. This is a description of Meshy's policy, not a guarantee of copyright protection or uniqueness. [S8, S9]
- Own generated assets, Free: help describes CC BY 4.0, commercial use allowed with Meshy attribution in the project description. These usage rights do not themselves grant download access. [S8]
- Download entitlement: current plan help says Free cannot download newly generated models; its stated exception is models previously generated while paid. Pro and above have unlimited model downloads and community download access. No account-specific entitlement was checked. [S10]
- Assets generated while paid retain their paid-generation rights after downgrade, according to help; newly generated Free assets follow CC BY 4.0. [S8]
- Community-published output: guidelines specify CC0; fetched Terms §3.3 describes CC0 1.0 Universal Public Domain Dedication. This applies to publication on Meshy Community, not everything merely visible on a public URL. [S11, S12]
- Community access: help says subscribers may download others' models at no additional cost; plan help excludes Free from community downloads. Subscription provides access, not exclusive ownership of another creator's work. [S10, S13]
- CC0 is the documented public-domain dedication, but Community guidelines also request proper attribution when using others' work. Preserve creator/source/license records and attribution for a trial; do not promise absence of every platform attribution obligation. No specific model's provenance or third-party rights were verified. [S11]
- Critical date uncertainty: fetched Terms says “Last Updated: September 19, 2026,” later than this September 13 access, and says amendments take effect on that displayed date. Current effective contractual text is therefore unconfirmed; §3.3 above is reported as fetched text, not a resolved current legal conclusion. [S12]
- Fetched Terms §3.1 separately licenses supplied rigs/animations/textures as Service Assets when incorporated into and needed to exploit output; do not extend generated-model ownership claims to standalone supplied assets. Same effective-date caveat applies. [S12]

## Agent/API integration
- Official Meshy REST API and official Meshy MCP server are documented. MCP wraps REST tools for generation, task status, remeshing, rigging/animation and result downloads; it requires a Meshy API key and a compatible configured client/runtime. Its documented package is @meshy-ai/meshy-mcp-server. No MCP invocation or installation performed. [S3, S14]
- Plan help lists API access for Pro/Premium/Ultra and team tiers, not Free. API pricing describes prepaid usage credits; MCP uses the same rates as REST. Do not assume a website subscription alone guarantees funded API usage or that all web/API credits are interchangeable: exact account balance/pool sharing was not verified. [S10, S14, S15]
- Controller's inventory found no exposed Meshy/Roblox-named connector and noted browser automation. That is session inventory, not evidence that an official integration does not exist. No API key, login, account, Studio installation or live import was verified.

## Access gaps and boundary
- Supplied Discover page fetched successfully, but its static response displayed placeholder collections and no search results; no model-level download/license was inspected. This is not evidence the community is empty. [S1]
- Guessed /terms returned no usable extracted text; /terms-of-use was fetched successfully, with the date issue above. No authentication/paywall bypass or credential access occurred.
- API retention pages differ: quick-start says non-Enterprise three days; plan comparison lists Studio fourteen days. Scope/effect is unknown; per controller ACK, no universal retention claim and no deeper plan research. [S10, S16]
- Missing: game URL/project folder, chosen original asset, its provenance/generation plan and intended static/NPC/avatar role. No account generation, model download/upload, payment, install, terms acceptance or app execution occurred.
- Public research and Markdown only: code/build/tests/Snyk are N/A. Confined push unavailable; actual PTY ACK/HOLD/REPORT supports controller pull review, not a claim of telepty inject delivery.

## 한국어 답변 제안
네. 캣또로롱 로블록스에 넣을 **3D 소품을 만드는 용도**로 사용할 수 있어요. Meshy에서 FBX로 내보내 Roblox Studio로 가져오는 경로가 있고, 공식 Roblox Bridge도 문서화돼 있어요. Bridge는 Pro 이상·별도 앱·Roblox 계정 연결이 필요합니다. [S2, S4–S6]
다만 커뮤니티 모델은 공개돼 있다는 이유만으로 쓰면 안 되고, 게시 라이선스와 다운로드 조건을 구분해야 해요. 문서는 Community CC0, 직접 만든 Free 모델 CC BY 4.0, 유료 비공개 생성물의 소유권을 설명합니다. 현재 약관 페이지의 미래 날짜와 출처 표기 문구는 확인이 남아 있습니다. 캐릭터는 리깅·애니메이션·아바타 규격도 따로 검증해야 합니다. [S7–S12]
**여기 에이전트에 연결하는 용도**도 공식 API/MCP 경로는 있지만, 이 세션에서 연결되거나 작동한다고 확인한 것은 아닙니다. 생성 모델만으로 게임이 완성되는 것도 아니에요. [S14, S15]
실용적인 다음 단계 하나: 게임 프로젝트 위치와 사용할 자체 창작 소품 하나(예: 고양이 밥그릇)를 정한 뒤, 별도 실행 승인 범위에서 권리·다운로드 자격 확인 → 최적화 → FBX 가져오기 → 크기·재질·충돌·성능 검증을 하는 소규모 시험을 제안합니다. 지금은 실행하지 않았습니다.

## Fetched official sources (all accessed in the window above)
- S1 https://www.meshy.ai/ko/discover
- S2 https://help.meshy.ai/en/articles/13456840-glb-vs-fbx-vs-obj-vs-stl-which-meshy-format-should-you-download
- S3 https://docs.meshy.ai/en/llms.txt
- S4 https://create.roblox.com/docs/art/modeling/3d-importer (served Importer; canonical surfaced as https://create.roblox.com/docs/en-us/studio/importer.md)
- S5 https://www.meshy.ai/integrations/roblox
- S6 https://help.meshy.ai/en/articles/15644142-meshy-to-roblox-studio-import-workflow-and-fixes
- S7 https://create.roblox.com/docs/art/characters/specifications
- S8 https://help.meshy.ai/en/articles/16102098-can-i-use-meshy-assets-commercially
- S9 https://help.meshy.ai/en/articles/10137554-what-is-the-ownership-of-the-generated-models
- S10 https://help.meshy.ai/en/articles/12062933-which-meshy-plan-is-right-for-you-free-vs-pro-vs-premium-vs-ultra
- S11 https://help.meshy.ai/en/articles/10225410-what-are-the-community-guidelines-for-meshy
- S12 https://www.meshy.ai/terms-of-use
- S13 https://help.meshy.ai/en/articles/10001881-what-is-the-meshy-community
- S14 https://docs.meshy.ai/api/ai.md
- S15 https://docs.meshy.ai/api/pricing.md
- S16 https://docs.meshy.ai/api/quick-start.md
