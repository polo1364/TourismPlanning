# 原創旅行插畫

以內建 `image_gen.imagegen` 工具生成，兩張皆為虛構的旅行意象，不是目的地實景或景點照片。原始 PNG 未經後製，介面透過 CSS `object-fit: cover` 裁切；不要用它們推斷所選城市的實際景觀。

| 檔案 | 尺寸 | 大小 | 用途 |
| --- | --- | --- | --- |
| `roam-coast.png` | 1536 × 1024 | 3,045,768 bytes | 海岸日光封面；街巷主題的明信片 |
| `roam-town.png` | 1536 × 1024 | 3,112,969 bytes | 街巷夜色封面；海岸主題的明信片 |

電子旅遊書也使用目前選定的插畫作為每日章節的封面背景，並標示「旅行意象插畫」。沒有依城市產生或下載景點實景圖。

## 海岸日光：實際生成提示詞

```text
Use case: stylized-concept. Create an exquisite original travel editorial hero illustration for a Traditional Chinese personal trip-planning web app called ROAM. Asset only, NO interface, NO lettering, NO typography, NO logos, no watermark. Wide panoramic 3:2 composition that also crops beautifully to a 2.4:1 banner. An imaginary Mediterranean-meets-East-Asian coastal journey seen from an elevated perspective: spectacular deep teal bay, winding pale road and a tiny vermilion vintage train crossing a curved viaduct, sunlit peach and ivory hillside village on the right, distant blue mountain layers, orange sun near horizon, a few cream clouds, one tiny sailboat. Lush olive foreground leaves framing the lower right, atmospheric warm sunlight. Handcrafted sophisticated travel poster / layered paper collage with delicate gouache textures, dimensional shadows, tactile paper, strong graphic shapes and elegant detail. Not childish, not clipart, not generic stock, no 3D plastic, no purple gradients. Palette: deep petrol blue #123d48, navy #202f48, warm ivory #faf8f2, burnt coral #c35335, golden sand #e8b86a, sage green. The left third mostly quiet deep teal ocean and atmospheric sky, with few details, allowing white HTML headline overlay; the right two-thirds hold the village/train/coast scene. A beautiful illustration worth collecting as a travel postcard. Keep the central mountain/coast silhouette compelling at mobile crop. High quality painterly finish.
```

## 街巷夜色：實際生成提示詞

```text
Use case stylized-concept. An original premium travel magazine illustration, landscape 3:2 aspect ratio, no text no letters no logos no watermark. An imaginary East Asian old town at blue hour, terracotta and ochre lantern glow, a red tram passing over a small arched stone bridge over a narrow canal, little timber shopfronts, tiled roofs, flowering trees, deep petrol blue layered hills behind, a few quiet strolling silhouettes, intimate magical atmosphere. Handcrafted sophisticated travel poster with gouache texture, tactile paper grain, subtly dimensional cut-paper layering and beautiful detailed brushwork. Elegant and cinematic, not cartoonish, not plastic 3D. Compose the lively village, bridge, lanterns and tram on the RIGHT two thirds; LEFT third has quiet deep teal canal and shadowy trees with soft glow and ample negative space for white web headline overlay. Palette petrol blue #123d48, deep navy #202f48, warm ivory #faf8f2, burnt coral #c35335 and luminous amber #e8b86a. No real landmark, purely an imaginative travel mood illustration. Must crop beautifully into a panoramic 2.4:1 web hero and a vertical mobile cover. High-end painterly travel illustration, dusk with warm reflections.
```
