import type { KeywordStore } from "../storage/keywords.js";
import type { AdminStore } from "../storage/admins.js";
import type { DigestRepository, DigestService } from "../digest.js";
import type { CalendarService } from "../calendar.js";

export interface BotServices {
  keywords: KeywordStore;
  admins: AdminStore;
  digestRepository: DigestRepository;
  digestService: DigestService;
  calendarService: CalendarService;
}
