"use client";

import { Button } from "./ui";

/** Opens the browser's print dialog; "Save as PDF" there gives the receipt as a file. */
export function ReceiptButton() {
  return (
    <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>
      Download receipt
    </Button>
  );
}
