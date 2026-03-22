# Plan

CPU 환경에서 GPT 모델의 val_bpb(bits per byte)를 최소화한다.

## 목표

train.py의 하이퍼파라미터, 아키텍처, 옵티마이저 설정을 반복 실험하여 val_bpb를 낮춘다.

## 제약사항

- 새로운 패키지 설치 불가.
- **GPU 없음. CPU 전용 환경.**
- 학습 시간 예산: 5분 (300초).

## 최우선 과제: CPU 호환성 확보

**train.py가 현재 GPU 전용이라 CPU에서 실행 불가.** 실험 반복 전에 반드시 아래 항목을 모두 수정하여 CPU에서 정상 트레이닝이 가능한 상태로 만들어야 한다.

수정 필수 항목:
1. `torch.cuda.get_device_capability()` 제거 — flash-attention-3 import 자체를 제거하고 `F.scaled_dot_product_attention` 사용
2. `torch.cuda.manual_seed(42)` → 제거 (torch.manual_seed만 유지)
3. `device = torch.device("cuda")` → `torch.device("cpu")`
4. `torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16)` → CPU에서는 autocast 제거 또는 `device_type="cpu"` 사용
5. `torch.cuda.synchronize()` 호출 전부 제거
6. `torch.cuda.max_memory_allocated()` → CPU에서는 0 또는 측정 불가로 처리
7. `H100_BF16_PEAK_FLOPS` 기반 MFU 계산 → CPU에 맞게 수정하거나 제거
8. `fa3.flash_attn_func()` → `F.scaled_dot_product_attention()` 으로 교체 (입력 shape 변환 필요)
9. bfloat16 캐스팅 — CPU에서 bfloat16 지원 여부 확인, 미지원 시 float32로 변경
10. DEVICE_BATCH_SIZE, DEPTH 등 하이퍼파라미터를 CPU에 적합한 값으로 축소

**이 수정이 완료되어 train.py가 CPU에서 에러 없이 돌아갈 때까지 [STAGE_COMPLETE]를 출력하지 마라.**

## 현재 CPU 기본 설정

- DEPTH: 4, model_dim: 256, n_head: 2
- DEVICE_BATCH_SIZE: 4
- 파라미터 수: ~11.5M
- 스텝당 약 1.5초, 5분간 ~200 스텝
