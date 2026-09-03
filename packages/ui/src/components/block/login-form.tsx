import { GoogleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@workspace/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/ui/card";
import { Field, FieldGroup } from "@workspace/ui/components/ui/field";
import { cn } from "@workspace/ui/lib/utils";

export function LoginForm({
  onSignIn,
  className,
  ...props
}: React.ComponentProps<"div"> & { onSignIn: () => void }) {
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>offdesk にログイン</CardTitle>
          <CardDescription>
            許可されたアカウントだけが入れます。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <Button type="button" onClick={onSignIn}>
                <HugeiconsIcon icon={GoogleIcon} strokeWidth={2} />
                Google でログイン
              </Button>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}
