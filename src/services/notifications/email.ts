import { Resend } from "resend";
import { env } from "../../config/env.js";

export class EmailService {
  private resend: Resend | null = null;
  private get client(): Resend | null {
    if (env.RESEND_API_KEY.length === 0) return null;
    this.resend ??= new Resend(env.RESEND_API_KEY);
    return this.resend;
  }

  public async sendReviewRequired(to: string, caseId: string): Promise<void> {
    const client = this.client;
    if (client === null) return;
    await client.emails.send({ from: "KYC Copilot <noreply@kyc-copilot.local>", to, subject: "KYC review required", text: `Case ${caseId} requires analyst review.` });
  }
}
