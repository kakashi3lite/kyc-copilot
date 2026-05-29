export const registryUrls: Readonly<Record<string, string>> = {
  NL: "https://www.kvk.nl/zoeken/",
  DE: "https://www.handelsregister.de/",
  GB: "https://find-and-update.company-information.service.gov.uk/",
  FR: "https://www.infogreffe.fr/",
  ES: "https://www.registradores.org/",
  IT: "https://registroimprese.it/"
};

export function registryUrlFor(jurisdiction: string): string {
  return registryUrls[jurisdiction.toUpperCase()] ?? "https://opencorporates.com/";
}
