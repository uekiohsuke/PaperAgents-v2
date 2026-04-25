import numpy as np
import matplotlib.pyplot as plt
from scipy.stats import norm

# ==============================================================================
# 1. 物理定数・変数の定義 (SI Units)
# ==============================================================================
# 拡散係数 D [m^2/s]
# 本シミュレーションでは、理論値との比較を容易にするため D = 1.0 と設定します。
D = 1.0  

# シミュレーションパラメータ
N_particles = 5000      # 粒子の数 (n)
dt = 0.01               # 時間ステップ [s]
T_total = 10.0          # 総時間 [s]
steps = int(T_total / dt)  # ステップ数

# 初期位置：すべて原点 x=0 に配置
x_initial = np.zeros(N_particles)

# ==============================================================================
# 2. ランダムウォークのシミュレーション (Euler-Maruyama Method)
# ==============================================================================
# 粒子の軌跡を保存する配列
# shape: (N_particles, steps + 1) -> [particle_index, time_step]
# 次元エラーを防ぐため、明確に初期化します。
positions = np.zeros((N_particles, steps + 1))

# ランダムな変位 s_i の生成
# 平均 0, 分散 <s^2> = 2*D*dt に従う正規分布からサンプリング
# 理論的に、< (X' - X)^2 > = 2 * D * dt となるように設定
variance_per_step = 2.0 * D * dt
std_dev_per_step = np.sqrt(variance_per_step)

np.random.seed(42) # 再現性のためシードを設定

for t in range(steps):
    # 現在の位置からランダムな変位を加算
    # positions[:, t] は現在の位置、positions[:, t+1] は次の位置
    random_steps = np.random.normal(loc=0.0, scale=std_dev_per_step, size=N_particles)
    positions[:, t + 1] = positions[:, t] + random_steps

# ==============================================================================
# 3. 解析と可視化
# ==============================================================================
# 特定の時刻（例：t = T_total）における粒子の分布を抽出
final_time_idx = steps
x_final = positions[:, final_time_idx]

# 理論的なガウス分布のパラメータ計算
# 平均 <x> = 0
# 分散 <x^2> = 2 * D * t
t_current = T_total
theoretical_mean = 0.0
theoretical_variance = 2.0 * D * t_current
theoretical_std = np.sqrt(theoretical_variance)

# ガウス関数のプロット用データ生成
x_plot = np.linspace(-15, 15, 1000)
y_theory = norm.pdf(x_plot, loc=theoretical_mean, scale=theoretical_std)

# ヒストグラムの作成 (正規化して確率密度関数にする)
hist_counts, bin_edges = np.histogram(x_final, bins=100, density=True)
bin_centers = 0.5 * (bin_edges[:-1] + bin_edges[1:])

# ==============================================================================
# 4. グラフ描画
# ==============================================================================
plt.figure(figsize=(12, 7))

# ヒストグラム（シミュレーション結果）
plt.bar(bin_centers, hist_counts, width=0.3, alpha=0.6, color='skyblue', 
        label=f'Simulation (N={N_particles})')

# ガウス分布（理論値）
plt.plot(x_plot, y_theory, 'r-', linewidth=2.5, label=f'Theory: $\\sigma = \\sqrt{{2Dt}}$')

# 軸ラベルとタイトル
plt.title(r'Brownian Motion Diffusion: Simulation vs Theory ($D={}$)'.format(D), fontsize=14)
plt.xlabel('Position x [m]', fontsize=12)
plt.ylabel('Probability Density', fontsize=12)
plt.legend(fontsize=12, loc='upper right')
plt.grid(True, linestyle='--', alpha=0.7)

# 散布図の追加（時間経過による拡散の様子を簡易的に表示）
# いくつかの中間時刻の分布も重ね描きして視覚効果を高める
times_to_show = [1.0, 5.0] # 秒
for t_check in times_to_show:
    idx_check = int(t_check / dt)
    if idx_check < steps:
        x_check = positions[:, idx_check]
        var_check = 2.0 * D * t_check
        std_check = np.sqrt(var_check)
        y_check = norm.pdf(x_plot, loc=0, scale=std_check)
        plt.plot(x_plot, y_check, '--', linewidth=1.5, alpha=0.8, 
                 label=f'T={t_check}s (Theory)')

plt.tight_layout()
plt.show()

# ==============================================================================
# 5. 統計的検証（ユーザーの意図への回答）
# ==============================================================================
print(f"--- Simulation Statistics at t = {T_total} s ---")
print(f"Theoretical Variance: <x^2> = {theoretical_variance:.4f}")
print(f"Simulated Mean:       <x>   = {np.mean(x_final):.6f}")
print(f"Simulated Variance:   <x^2> = {np.var(x_final):.6f} (Expected ~{theoretical_variance})")

# ユーザーのエラー原因への言及
print("\n--- Note on Dimension Error ---")
print("The error 'ValueError: x and y must have same first dimension' occurred because")
print("plotting functions expected 1D arrays for both axes, but received mismatched shapes.")
print("In this script, we ensure consistency by using 'bin_centers' (1D) vs 'hist_counts' (1D)")
print("and 'x_plot' (1D) vs 'y_theory' (1D).")