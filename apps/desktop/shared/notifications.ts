export interface ActivityNotification {
  id: string;
  chatId: string;
  space: 'home' | 'code' | 'design';
  title: string;
  body: string;
  createdAt: number;
  read: boolean;
}

export interface ActivityNotificationState {
  items: ActivityNotification[];
  enabled: boolean;
}
