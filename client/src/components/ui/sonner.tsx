import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts, dressed to the design rather than to Sonner's defaults.
 *
 * Sonner ships rounded corners, a shadow and its own light/dark palette, and
 * this app has `--radius: 0rem`, no shadows anywhere, and one theme. So the
 * classes below are not decoration — they are the whole reason this wrapper
 * exists, and removing any of them puts a rounded, floating, differently
 * coloured box on a page that has none.
 *
 * The toaster renders in a portal on `document.body`, outside the app frame.
 * That is fine for direction, which `<html dir="rtl">` already covers, and for
 * the face, which is set on `html` and inherits — but Sonner sets its own
 * `font-family` on the toast, so it is stated again here. Without it the
 * Persian reads in the browser's default sans and the numerals come out Latin.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      dir="rtl"
      position="bottom-center"
      // Sonner's own theme switch would pick light from the OS; this app is
      // one theme and the tokens below already say which.
      theme="dark"
      toastOptions={{
        classNames: {
          toast:
            "!rounded-none !border !border-border !bg-card !text-foreground !shadow-none !font-sans",
          title: "!font-medium",
          description: "!text-muted-foreground",
          actionButton: "!rounded-none",
          cancelButton: "!rounded-none",
        },
      }}
      {...props}
    />
  );
}
