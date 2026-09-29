// A table of physical things offers the floor plan's place mode with its own
// things listed: the door from where the things are to where they go, on
// every such table without each page having to remember it (CollectionHeader
// draws it from the table's kind).
import { Link } from "react-router-dom";
import { MapPin } from "lucide-react";
import { useFaces } from "./faces";

export function PlaceOnPlan({ kind }: { kind: string }) {
  const { verdict } = useFaces(kind);
  if (verdict?.traits.tangibility !== "physical") return null;
  return (
    <Link
      to={`/locations/place?collection=${encodeURIComponent(kind)}`}
      data-testid="place-on-plan"
      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
    >
      <MapPin size={12} /> Place on the floor plan
    </Link>
  );
}
