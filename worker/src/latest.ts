// 人ごとに「最後に主催した募集」を覚えておく。パネルの「⏰ 最後の募集の時刻を設定」で使う。
// ユーザーIDごとに1つの Durable Object を使う。

import { DurableObject } from "cloudflare:workers";

export interface LatestRecruitInfo {
  recruitId: string;
  channelId: string;
  messageId: string;
}

export class LatestRecruit extends DurableObject {
  async set(info: LatestRecruitInfo): Promise<void> {
    // 記録は投稿後に非同期で届くので、順番が前後しても新しい募集（IDが大きい方）を残す
    const current = await this.ctx.storage.get<LatestRecruitInfo>("latest");
    if (current && BigInt(current.recruitId) > BigInt(info.recruitId)) return;
    await this.ctx.storage.put("latest", info);
  }

  async get(): Promise<LatestRecruitInfo | undefined> {
    return this.ctx.storage.get<LatestRecruitInfo>("latest");
  }
}
