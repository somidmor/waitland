import type { HTMLAttributes, ReactNode } from "react";

type IconProps = HTMLAttributes<HTMLSpanElement>;

type IconShellProps = IconProps & {
  children?: ReactNode;
  name: "people" | "send" | "compass" | "edit" | "stone";
};

function IconShell({ children, className, name, ...props }: IconShellProps) {
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);

  return (
    <span
      {...props}
      aria-hidden={props["aria-hidden"] ?? (labelled ? undefined : true)}
      className={["ui-icon", `ui-icon--${name}`, className].filter(Boolean).join(" ")}
      role={props.role ?? (labelled ? "img" : undefined)}
    >
      {children}
    </span>
  );
}

export function PeopleIcon(props: IconProps) {
  return <IconShell name="people" {...props} />;
}

export function SendIcon(props: IconProps) {
  return <IconShell name="send" {...props} />;
}

export function CompassIcon(props: IconProps) {
  return <IconShell name="compass" {...props} />;
}

export function EditIcon(props: IconProps) {
  return <IconShell name="edit" {...props} />;
}

export function StoneIcon(props: IconProps) {
  return <IconShell name="stone" {...props} />;
}
