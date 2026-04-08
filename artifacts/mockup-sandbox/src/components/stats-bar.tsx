import { Activity, Bell, Copy, Wifi } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

export function StatsBar(props: {
  totalAlerts: number;
  newToday: number;
  duplicatesBlocked: number;
  isOnline: boolean;
}) {
  const items = [
    {
      label: "סה״כ התראות",
      value: props.totalAlerts,
      icon: Bell,
    },
    {
      label: "חדש / פעיל",
      value: props.newToday,
      icon: Activity,
    },
    {
      label: "כפילויות נחסמו",
      value: props.duplicatesBlocked,
      icon: Copy,
    },
    {
      label: "מקור נתונים",
      value: props.isOnline ? "מחובר" : "לא זמין",
      icon: Wifi,
      valueClass: props.isOnline ? "text-emerald-600" : "text-destructive",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label}>
          <CardContent className="p-4 flex items-center justify-between gap-3">
            <div className="text-right space-y-1 min-w-0">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p
                className={`text-2xl font-semibold tabular-nums ${item.valueClass ?? ""}`}
              >
                {item.value}
              </p>
            </div>
            <item.icon className="size-8 text-muted-foreground shrink-0" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
