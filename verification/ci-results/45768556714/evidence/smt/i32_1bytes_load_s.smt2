; benchmark generated from python API
(set-info :status unknown)
(declare-fun logical_size () (_ BitVec 32))
(declare-fun addr () (_ BitVec 32))
(declare-fun base () (_ BitVec 32))
(declare-fun physical () (Array (_ BitVec 32) (_ BitVec 8)))
(declare-fun logical () (Array (_ BitVec 32) (_ BitVec 8)))
(assert
 (let ((?x15 ((_ zero_extend 32) logical_size)))
 (bvsle (bvadd ((_ zero_extend 32) addr) (_ bv1 64)) ?x15)))
(assert
 (bvsle (bvadd ((_ zero_extend 32) base) ((_ zero_extend 32) logical_size)) (_ bv4294967296 64)))
(assert
 (let ((?x23 (select logical (bvadd addr (_ bv0 32)))))
 (= ?x23 (select physical (bvadd (bvadd base addr) (_ bv0 32))))))
(assert
 (let ((?x24 (bvadd base addr)))
(let ((?x32 (select physical ?x24)))
(let ((?x59 ((_ sign_extend 24) ?x32)))
(let ((?x31 (bvadd (_ bv0 32) (bvmul ((_ zero_extend 24) (select logical (bvadd addr (_ bv0 32)))) (_ bv1 32)))))
(let ((?x63 (ite (= ((_ extract 7 7) ?x31) (_ bv1 1)) (bvor ?x31 (_ bv4294967040 32)) ?x31)))
(and (distinct ?x63 ?x59) true)))))))
(check-sat)
