// What the toast says when a scan became another place of an item: the same
// words from every surface that files one (#4552).
export function addedPlaceSentence(title: string, place: { location_name: string | null; qty: number }): string {
  return place.location_name
    ? `Kept ${place.qty} in ${place.location_name} as another place of ${title}`
    : `Kept ${place.qty} as another place of ${title}`;
}
