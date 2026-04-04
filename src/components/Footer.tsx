export default function Footer() {
  return (
    <footer className="py-20 border-t border-white/5">
      <div className="container mx-auto px-6">
        <div className="grid md:grid-cols-4 gap-12 mb-20">
          <div className="col-span-2">
            <div className="flex items-center gap-2 mb-8">
              <div className="w-6 h-6 bg-white rounded-full flex items-center justify-center">
                <div className="w-3 h-3 bg-black rounded-sm rotate-45" />
              </div>
              <span className="font-sans font-semibold tracking-tighter text-lg uppercase">The Medallion Club</span>
            </div>
            <p className="max-w-sm text-white/40 text-sm leading-relaxed">
              A private investment partnership focused on quantitative strategies. 
              Access is strictly limited to institutional and qualified investors.
            </p>
          </div>
          
          <div>
            <h4 className="text-xs font-bold uppercase tracking-widest mb-6">Navigation</h4>
            <ul className="space-y-4 text-sm text-white/40">
              <li><a href="#" className="hover:text-white transition-colors">Philosophy</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Performance</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Access</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Legal</a></li>
            </ul>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-widest mb-6">Contact</h4>
            <ul className="space-y-4 text-sm text-white/40">
              <li>Mayfair, London</li>
              <li>Zurich, Switzerland</li>
              <li>invest@medallionclub.ai</li>
            </ul>
          </div>
        </div>

        <div className="flex flex-col md:flex-row justify-between items-center gap-6 pt-12 border-t border-white/5 text-[10px] uppercase tracking-widest text-white/20">
          <div>© 2026 The Medallion Club. All rights reserved.</div>
          <div className="flex gap-8">
            <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
            <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
            <a href="#" className="hover:text-white transition-colors">Disclosures</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
