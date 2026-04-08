import { Download, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const AGENCIES = ["אגד", "דן", "קווים", "מטרופולין"] as const;

export function ControlPanel(props: {
  onScanAgency: (agency: string) => void;
  onScanAll: () => void;
  isScanning: boolean;
  scanningAgency: string | null;
  scanInterval: string;
  onIntervalChange: (v: string) => void;
  onExport: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg text-right">פעולות סריקה</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 justify-end">
          <Button
            variant="default"
            disabled={props.isScanning}
            onClick={() => props.onScanAll()}
          >
            {props.isScanning && props.scanningAgency === "all" ? (
              <Loader2 className="size-4 animate-spin ms-1" />
            ) : (
              <RefreshCw className="size-4 ms-1" />
            )}
            סריקת כל המפעילים
          </Button>
          {AGENCIES.map((a) => (
            <Button
              key={a}
              variant="outline"
              size="sm"
              disabled={props.isScanning}
              onClick={() => props.onScanAgency(a)}
            >
              {props.isScanning && props.scanningAgency === a ? (
                <Loader2 className="size-4 animate-spin ms-1" />
              ) : null}
              {a}
            </Button>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-end justify-between">
          <div className="space-y-2 text-right flex-1 max-w-xs ms-auto sm:ms-0">
            <Label htmlFor="scan-interval">מרווח סריקה (שעות)</Label>
            <Input
              id="scan-interval"
              value={props.scanInterval}
              onChange={(e) => props.onIntervalChange(e.target.value)}
              dir="ltr"
              className="text-center"
            />
          </div>
          <Button variant="secondary" onClick={props.onExport}>
            <Download className="size-4 ms-1" />
            ייצוא דוח
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
